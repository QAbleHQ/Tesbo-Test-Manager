/**
 * Resolving the three values that identify a Tesbo target: which server, which project, which
 * credential.
 *
 * Extracted from the reporter so the `doctor` CLI validates *the same* resolution the reporter will
 * perform. A doctor that re-implemented this would happily pass while the reporter failed, which is
 * worse than having no doctor at all.
 *
 * There is deliberately **no user field**. The credential carries the identity: a project API token
 * records the human who issued it (`api_tokens.user_id`), and every run and result is attributed to
 * them. A configurable `user` would let any client claim to be anyone.
 */

/** The three values, as a caller may pass them inline. Each falls back to its env var. */
import { CONFIG_FILENAME, NO_FILE_CONFIG, type FileConfig } from "./file-config";

export interface TesboConfigInput {
  projectId?: string;
  token?: string;
  baseUrl?: string;
}

export interface ResolvedTesboConfig {
  /** Origin only, no trailing slash and no `/api` suffix — the client appends the path. */
  baseUrl: string;
  projectId: string;
  token: string;
}

export const ENV_BASE_URL = "TESBO_BASE_URL";
export const ENV_PROJECT_ID = "TESBO_PROJECT_ID";
export const ENV_TOKEN = "TESBO_API_TOKEN";

/**
 * Why resolution has four outcomes rather than ok/failed.
 *
 * The distinction between `unconfigured` and `incomplete` is the whole point, and it is what fixes
 * the silent-success failure mode:
 *
 * - **`unconfigured`** — none of the three is set. This is a legitimate opt-out: a fork's pull
 *   request build has no secrets, and the card (§7) asks that this never break the suite. Warn and
 *   stay out of the way.
 * - **`incomplete`** — some are set and some are not. Nobody half-configures a reporter on purpose.
 *   This is a typo in a variable name or a secret that did not reach the runner, and reporting
 *   nothing while exiting 0 is precisely the outcome that hides it for weeks. Fail loudly.
 *
 * Collapsing the two — which the reporter used to do — means the common misconfiguration is treated
 * as the rare deliberate opt-out.
 */
export type ConfigResolution =
  | { state: "ok"; config: ResolvedTesboConfig; notes: string[] }
  | { state: "unconfigured"; message: string }
  | { state: "incomplete"; missing: string[]; message: string }
  | { state: "invalid"; message: string };

interface BaseUrlNormalization {
  /** Null when the value could not be understood as an http(s) origin at all. */
  origin: string | null;
  /** Set when the value was a full project URL, e.g. the MCP endpoint from Project Settings. */
  inferredProjectId?: string;
  notes: string[];
  error?: string;
}

/** A UUID, which is what a Tesbo project id is — used to recognise one inside a pasted URL. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reduces whatever the user pasted to the origin the HTTP client needs.
 *
 * This is forgiving on purpose, because there are exactly three things a person copies out of the
 * product and all three are *nearly* right:
 *
 *   https://api.example.com                                  — already correct
 *   https://api.example.com/api                              — the client appends `/api`, so this doubles it
 *   https://api.example.com/api/projects/<uuid>/mcp           — the MCP URL from Project Settings
 *
 * The third is the interesting one: it carries the project id too, so pasting it configures two of
 * the three values at once. Rejecting it as malformed would be technically defensible and actively
 * unhelpful.
 */
export function normalizeBaseUrl(raw: string): BaseUrlNormalization {
  const notes: string[] = [];
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return { origin: null, notes, error: "is empty" };

  if (!/^https?:\/\//i.test(trimmed)) {
    return {
      origin: null,
      notes,
      error: `must start with http:// or https:// (got "${trimmed}")`
    };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { origin: null, notes, error: `is not a valid URL ("${trimmed}")` };
  }

  let inferredProjectId: string | undefined;
  const projectPath = /^\/api\/projects\/([^/]+)(?:\/.*)?$/i.exec(url.pathname);
  if (projectPath && projectPath[1] && UUID.test(projectPath[1])) {
    inferredProjectId = projectPath[1];
    notes.push(
      `Read the project id ${inferredProjectId} out of the URL you gave, and trimmed it back to the server origin.`
    );
  } else if (/^\/api\/?$/i.test(url.pathname)) {
    notes.push("Trimmed the trailing /api — the SDK appends it, so leaving it on would request /api/api/…");
  } else if (url.pathname !== "/" && url.pathname !== "") {
    notes.push(`Ignored the path "${url.pathname}" — only the server origin is used.`);
  }

  /*
   * The mistake this catches cost a real debugging session, and it fails invisibly: Tesbo serves the
   * web app and the API on separate hosts (app-stage.tesbo.io vs api-app-stage.tesbo.io) and the
   * frontend has no /api rewrite, so the app host answers every ingest call with a 404 that the
   * client — by design — logs without throwing. The suite stays green and no results ever appear.
   *
   * A warning rather than an error: a self-hosted deployment may legitimately serve both from one
   * host, and refusing to run would be wrong for them.
   */
  if (/^app[.-]/i.test(url.hostname)) {
    notes.push(
      `"${url.hostname}" looks like the web app host, not the API host. Tesbo serves them separately ` +
        `(the API is usually "api-${url.hostname}"). If results never appear, this is why — the app ` +
        `host answers the ingest with 404s that are logged, not thrown.`
    );
  }

  return { origin: url.origin, inferredProjectId, notes };
}

/**
 * Resolves inline options over environment variables, and says which of the four states it landed in.
 *
 * `baseUrl` has **no default**. It used to default to `https://app.tesbo.io`, which is the web app
 * rather than the API and so could not work for anyone; and there is no correct default for a
 * self-hosted install regardless. Requiring it explicitly turns a silent 404 storm into a message
 * before the first test runs.
 */
export function resolveConfig(
  input: TesboConfigInput = {},
  env: NodeJS.ProcessEnv = process.env,
  /*
   * Defaults to "no file" rather than reading the disk, so a caller — and every test — gets a pure
   * function unless it deliberately opts in. The reporter and the CLI both pass `readConfigFile()`,
   * which is what keeps doctor validating the same resolution the reporter performs.
   */
  file: FileConfig = NO_FILE_CONFIG
): ConfigResolution {
  // A file that exists but cannot be parsed is never treated as absent: whoever wrote it meant to
  // configure reporting, and degrading to "unconfigured" would report nothing and still exit 0.
  if (file.error) return { state: "invalid", message: file.error };

  const fromFile: string[] = [];
  const pick = (inline: string | undefined, name: string, key: keyof TesboConfigInput): string | undefined => {
    const direct = inline ?? env[name];
    if (direct && direct.trim()) return direct.trim();
    const fileValue = file.values[key];
    if (fileValue && fileValue.trim()) {
      fromFile.push(name);
      return fileValue.trim();
    }
    return undefined;
  };

  const rawBaseUrl = pick(input.baseUrl, ENV_BASE_URL, "baseUrl");
  let projectId = pick(input.projectId, ENV_PROJECT_ID, "projectId");
  const token = pick(input.token, ENV_TOKEN, "token");

  const notes: string[] = [];
  // Said out loud so a value nobody remembers setting is traceable to the file that supplies it.
  if (fromFile.length) notes.push(`${fromFile.join(", ")} read from ${CONFIG_FILENAME}.`);
  let baseUrl: string | undefined;

  if (rawBaseUrl) {
    const normalized = normalizeBaseUrl(rawBaseUrl);
    if (!normalized.origin) {
      return { state: "invalid", message: `${ENV_BASE_URL} ${normalized.error}` };
    }
    baseUrl = normalized.origin;
    notes.push(...normalized.notes);
    // Only fills a gap; an explicit project id always wins, and a conflict is worth saying out loud
    // rather than silently preferring one.
    if (normalized.inferredProjectId) {
      if (!projectId) projectId = normalized.inferredProjectId;
      else if (projectId.toLowerCase() !== normalized.inferredProjectId.toLowerCase()) {
        notes.push(
          `The URL names project ${normalized.inferredProjectId} but ${ENV_PROJECT_ID} is ${projectId}; using ${projectId}.`
        );
      }
    }
  }

  const missing: string[] = [];
  if (!baseUrl) missing.push(ENV_BASE_URL);
  if (!projectId) missing.push(ENV_PROJECT_ID);
  if (!token) missing.push(ENV_TOKEN);

  if (missing.length === 3) {
    return {
      state: "unconfigured",
      message:
        `not configured — ${ENV_BASE_URL}, ${ENV_PROJECT_ID} and ${ENV_TOKEN} are all unset, so results ` +
        `will not be reported. Run "npx @tesbox/playwright-reporter init" to set them up, or pass ` +
        `enabled: false to silence this.`
    };
  }

  if (missing.length) {
    return {
      state: "incomplete",
      missing,
      message:
        `partially configured: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing. ` +
        `Reporting is configured but cannot work, so this is a hard failure rather than a warning — ` +
        `a run that quietly reported nothing would look exactly like a run that succeeded. ` +
        `Run "npx @tesbox/playwright-reporter doctor" to check the values.`
    };
  }

  return {
    state: "ok",
    // Non-null: `missing` is empty, so all three were resolved above.
    config: { baseUrl: baseUrl!, projectId: projectId!, token: token! },
    notes
  };
}

/** Masks a token for display: enough to recognise which one it is, not enough to use. */
export function maskToken(token: string): string {
  if (token.length <= 12) return "…";
  return `${token.slice(0, 9)}…${token.slice(-4)}`;
}
