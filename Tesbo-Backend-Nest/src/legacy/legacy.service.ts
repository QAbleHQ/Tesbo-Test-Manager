import { BadRequestException, ConflictException, ForbiddenException, forwardRef, HttpException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from "@nestjs/common";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import * as fs from "fs";
import * as path from "path";
import ExcelJS from "exceljs";
import archiver from "archiver";
import pdfParse from "pdf-parse";
import * as mammoth from "mammoth";
import { createWorker } from "tesseract.js";
import type { PoolClient, QueryResultRow } from "pg";
import { EmailService } from "../auth/email.service";
import { PasswordService } from "../auth/password.service";
import { AppConfigService } from "../config/app-config.service";
import { DatabaseService } from "../database/database.service";
import { endZyraTurn, recordExistingCoverage, recordGeneration, recordJiraContext, recordKnowledgeContext, startZyraTurn } from "../observability/ai-trace";
import { StorageService } from "../storage/storage.service";
import { encryptSecret, decryptSecret } from "../common/crypto.util";
import { escapeHtml, jiraDescriptionToText } from "../common/integration-text.util";
import { validatePersonName } from "../common/person-name.util";
import { ApiTokenService } from "../auth/api-token.service";
import { RagIngestionService } from "../rag/rag-ingestion.service";
import { RagRetrievalService } from "../rag/rag-retrieval.service";
import { IntegrationSyncService } from "../integration-sync/integration-sync.service";
import { PlanLimitsService } from "../plan-limits/plan-limits.service";
import { CustomFieldsService, CustomFieldWriteContext } from "../custom-fields/custom-fields.service";
import { CustomFieldDefinitionDto, QueryRunner } from "../custom-fields/custom-fields.types";

type Body = Record<string, any>;

/** The four buckets V67's bugs_severity_check allows, and the four the dashboard reports. */
const BUG_SEVERITIES = ["Critical", "High", "Medium", "Low"] as const;
/*
 * Bug priority — Basecamp 10226247009. Severity is how bad it is, priority is how soon it gets
 * worked on; a cosmetic defect on the signup page is Low severity and P0 priority. P0..P3 is the
 * scale `testcases.priority` already uses, and keeping it distinct from severity's words is what
 * stops rows reading "Critical / Critical" where nobody can tell the two fields apart.
 *
 * Nullable end to end: no priority means nobody has triaged it yet, which is a different fact from
 * "someone decided it is P2".
 */
const BUG_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

/** Sentinel `suiteId` query value meaning "test cases with no suite assigned" (suite_id IS NULL). */
export const UNASSIGNED_SUITE_ID = "none";

export interface InvitationRow {
  id: string;
  organization_id: string;
  email: string;
  role: string;
  status: string;
  expires_at: string;
  project_ids: string[];
}

function normalizeTestcaseIdPrefix(value: unknown): string {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 3);
}

/**
 * Collapses a title or suite name to the form the import compares on: trimmed, inner runs of
 * whitespace squeezed to one space, lowercased.
 *
 * Deliberately mirrors normalizeTitle/normalizeSuiteName in
 * Tesbo-Frontend/components/ImportTestCasesModal.tsx character for character. The browser used to
 * own both comparisons; it still shows the preview, so if the two ever drift a row would look like
 * a duplicate on one side and a fresh title on the other.
 */
function normalizeImportName(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Cache key for a suite, which an import identifies by name within its parent rather than by id. */
function importSuiteKey(name: string, parentId: string | null): string {
  return `${parentId ?? "root"}::${normalizeImportName(name)}`;
}

/** One spreadsheet row that passed validation, with its column values settled and its suite resolved. */
interface PreparedImportRow {
  rowNumber: number;
  title: string;
  description: string;
  preconditions: string;
  postconditions: string;
  steps: unknown[];
  testData: string;
  priority: string;
  severity: string | null;
  type: string;
  status: string;
  /** Stored on the test case itself, and also the name of the subfolder it goes in. */
  component: string | null;
  estimatedDuration: string | null;
  suiteName: string;
  componentName: string;
  customFieldValues: Body;
  /** The suite the component nests under: the row's own suite, or the folder the user had open. */
  parentSuiteId: string | null;
  /** Where the test case actually lands — the component's suite when it names one, else the parent. */
  suiteId: string | null;
}

/** The parts of an import that are fixed for the whole request, threaded through its helpers. */
interface ImportContext {
  projectId: string;
  uid: string;
  organizationId: string;
  idPrefix: string;
  defaultSuiteId: string | null;
  suiteIdByKey: Map<string, string>;
  expandSuiteIds: Set<string>;
  customFieldContext: CustomFieldWriteContext | null;
}

function parseSettings(raw: unknown): Body {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof raw === "object" && !Array.isArray(raw) ? raw as Body : {};
}

const ZYRA_AGENT_NAME = "Zyra the Test Generator";
const LEGACY_ZYRA_AGENT_NAME = "Zyra the Edge Hunter";
const ZYRA_AGENT_NAMES = [ZYRA_AGENT_NAME, LEGACY_ZYRA_AGENT_NAME];

/** Frontend treats this path as "no custom logo" and renders the theme-aware lockup. */
const DEFAULT_BRAND_LOGO_URL = "/brand/tesbo-logo-horizontal.svg";

type ZyraGenerationInput = {
  story: string;
  context: string;
  acceptanceCriteria: string;
  feedback: string;
  knowledge: Array<{ title: string; content: string }>;
  jira: Array<{ key: string; summary: string; description: string }>;
  linear: Array<{ key: string; summary: string; description: string }>;
  existingTestcases: Array<{ externalId: string; title: string; description: string; priority: string; status: string; stepsSummary: string }>;
  requestedCount: number;
  testcaseRange?: string; // "minimum" | "1-10" | "10-30" | "all"
};

type ZyraAiUsage = {
  input: number;
  output: number;
  total: number;
  cached: number;
};

type ZyraAiResult = {
  drafts: Body[];
  usage: ZyraAiUsage;
  requestId?: string;
};

type ZyraChatDecision = {
  reply: string;
  reasoningSummary: string;
  actionType: "answer" | "create" | "update" | "archive" | "suite" | "mixed";
  operations: Array<{
    type: "create" | "update" | "archive" | "create_suite" | "move_to_suite";
    testcaseId?: string;
    externalId?: string;
    // move_to_suite: testcases to move (by external id and/or internal id), or every existing testcase
    externalIds?: string[];
    testcaseIds?: string[];
    allExisting?: boolean;
    // move_to_suite: every testcase from the most recently generated batch (see
    // "Most recently generated batch" in the prompt) — use instead of externalIds when the
    // user refers to "all"/"the N cases" from a recent generation rather than naming specific ones.
    fromLastPlan?: boolean;
    // create_suite / move_to_suite target (suite is created by name when it does not exist yet)
    suiteName?: string;
    suiteId?: string;
    draft?: Body;
    fields?: Body;
    reason?: string;
  }>;
  testcases: Body[];
  // Set only when a provider call genuinely never answered within its budget (see
  // ZYRA_ROUTER_TIMEOUT_MS/ZYRA_GENERATE_TIMEOUT_MS) — never for a call that answered with an error.
  // sendZyraChatMessage persists this turn as status 'timed_out' instead of 'completed', and stores
  // resumeCheckpoint so a later POST .../messages/:messageId/continue can pick the SAME turn back up
  // — skipping whatever already succeeded — rather than asking the user to repeat themselves or
  // silently re-running the whole thing (which would double the wait with no more feedback than the
  // first attempt gave). See continueZyraChatMessage.
  timedOut?: boolean;
  resumeCheckpoint?: ZyraResumeCheckpoint;
};

// What continueZyraChatMessage needs to pick a timed-out turn back up without repeating the work
// that already finished. "router" means the routing call itself never answered — there is nothing
// yet to skip, so resuming just retries buildZyraChatDecision from the same user message. "generate"
// means the router DID resolve an intent/suite/count before the drafting call timed out, so resuming
// skips the router entirely and calls generateZyraChatCreateDecision directly with the already-routed
// suite/count — the part of "starting from scratch" this exists to avoid.
type ZyraResumeCheckpoint = {
  stage: "router" | "generate";
  userMessageId: string;
  message: string;
  routedSuite?: { id?: string; name?: string } | null;
  routedCount?: { requestedCount?: unknown; exhaustive?: boolean };
};

// Shape of applyZyraChatOperations' result that the reply-reconciliation path (finalizeZyraChatReply,
// reconcileZyraReply) reads from. moveBreakdown is the ground-truth per-suite count for whatever
// move_to_suite operations ran this turn — see zyraMoveBreakdown for how it's computed.
type ZyraAppliedOperations = {
  testcases: Body[];
  activity: Body[];
  moveBreakdown?: Array<{ suiteId: string; suiteName: string; created: boolean; count: number }>;
  reviewRequestId: string | null;
};

// What the AI router decided this request is (intentFromZyraModelAction). There is no keyword
// classifier producing these — the model reads the request in the context of the conversation and
// the project, and the system dispatches on its answer.
type ZyraChatIntent = "answer" | "example" | "list" | "create" | "update" | "archive" | "suite" | "jira_pending_testcases";

// Configurable Zyra capabilities (per project, stored under project.settings.zyraAgent.capabilities).
// All default to enabled so existing projects behave unchanged until a user turns one off.
type ZyraCapabilities = {
  generation: boolean;      // author/generate new testcases (chat "create" + task-board generation)
  knowledgeBase: boolean;   // read the project Knowledge Base into Zyra's context
  testcaseStorage: boolean; // write to the testcase repository: create / update / archive / bulk
  suiteOperations: boolean; // create suites and move/assign testcases into suites
};

type ZyraChatProjectSnapshot = {
  knowledgeCount: number;
  knowledgeTitles: string[];
  suites: Array<{ id: string; name: string; testCaseCount: number }>;
  testcaseCount: number;
  unassignedTestCaseCount: number;
  linkedJiraTestcaseCount: number;
  jiraConnected: boolean;
  jiraProjectCount: number;
  jiraTicketCount: number;
  pendingJiraTicketCount: number;
  lastJiraSyncAt: string | null;
};

function camel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function toCamel<T extends QueryResultRow>(row: T): Body {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [camel(key), value]));
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(?:^-)|(?:-$)/g, "")
    .slice(0, 64) || "workspace";
}

/** Slug candidates tried per workspace: the bare slug first, then suffixed retries. */
const ORG_SLUG_ATTEMPTS = 5;

/**
 * Inserts a workspace, giving it a globally-unique slug even when the *name* is already taken.
 *
 * `organizations.slug` is UNIQUE across the whole install, but workspace names are not — and never
 * should be. "QA", "Platform" and "Acme" get picked independently by unrelated signups all over the
 * world. Inserting a bare slugify(name) meant the second such signup died on the unique constraint
 * and surfaced to the user as a server error on an otherwise-valid workspace name.
 *
 * A workspace's identity is its UUID `id` plus its owner row in organization_members — never its
 * name — so the slug is free to carry a random disambiguator. The bare slug is tried first so the
 * first claimant keeps a readable handle; collisions fall back to `<name>-<6 hex>`. Nothing routes
 * or looks up by slug (renaming a workspace already leaves the slug behind), so the suffix is
 * invisible to the product.
 *
 * Each attempt runs inside a SAVEPOINT because both callers insert within a transaction, where a
 * failed statement would otherwise poison every statement after it.
 */
async function insertOrganization(client: PoolClient, name: string, country: string | null): Promise<string> {
  const base = slugify(name);
  for (let attempt = 0; attempt < ORG_SLUG_ATTEMPTS; attempt++) {
    // 57 chars + "-" + 6 hex keeps every candidate inside slug's VARCHAR(64).
    const slug = attempt === 0 ? base : `${base.slice(0, 57).replace(/-$/, "")}-${randomBytes(3).toString("hex")}`;
    await client.query("SAVEPOINT org_slug");
    try {
      const org = await client.query<{ id: string }>(
        "INSERT INTO organizations (name, slug, country) VALUES ($1, $2, $3) RETURNING id",
        [name, slug, country]
      );
      await client.query("RELEASE SAVEPOINT org_slug");
      return org.rows[0].id;
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT org_slug");
      if ((error as { code?: string })?.code !== "23505") throw error;
    }
  }
  throw new ConflictException({ error: "Could not create the workspace right now. Please try again." });
}

/**
 * Normalizes a self-reported country to an ISO 3166-1 alpha-2 code, or null.
 *
 * Returns null rather than throwing for anything unrecognized: this is a soft signal used only as a
 * pricing-detection fallback, so a junk value should degrade to "not provided" instead of failing an
 * otherwise-valid signup or rename.
 */
function normalizeCountryCode(value: unknown): string | null {
  const code = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/**
 * Every id in this schema is a uuid column, so a malformed id reaches Postgres as a cast error
 * (22P02) and surfaces to the caller as a 500. Ids that arrive from a URL or a request body are
 * checked with this first, so "not-a-uuid" is answered the same way a well-formed id that doesn't
 * exist is — a clean 404/400, not an internal error.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A pagination parameter as a whole number inside its bounds, falling back when it isn't one.
 *
 * `Number("abc")` is NaN, and NaN survives Math.min/Math.max unchanged — so the previous
 * `Math.max(1, Math.min(100, Number(query.limit || 25)))` passed NaN straight into a LIMIT clause and
 * Postgres answered the request with an error. Every paginated endpoint could therefore be turned
 * into a 500 by typing a word into a query string. Non-finite input now reads as "not supplied",
 * which is the same thing a caller who omitted it gets.
 *
 * A limit of 0 is left alone rather than raised to 1: asking for the total without any rows is a
 * legitimate request, and api/testcases.spec.ts pins it as the contract. Only a negative value and a
 * non-number are corrected.
 */
export function pageNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  const base = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  return Math.min(Math.max(base, min), max);
}

export function isUuid(value: unknown): boolean {
  return UUID_RE.test(String(value ?? ""));
}

// Product-chosen cap (matches PROJECT_NAME_MAX_LENGTH), well under the projects.key VARCHAR(32)
// column. Derived keys use a shorter 16 and leave the rest of that budget for a uniqueness suffix.
const PROJECT_KEY_MAX_LENGTH = 30;

function sanitizeKey(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

// Only for a key derived from the project name (body.key omitted) — auto-derived keys are kept
// short for readability, unlike a key the user typed on purpose (see validateProjectKey).
function projectKey(value: string): string {
  return sanitizeKey(value).slice(0, 16) || "TESBO";
}

/**
 * An explicitly supplied key used to be silently uppercased, stripped of non-alphanumerics, and
 * cut to 16 characters via projectKey() — so typing a 40-character key succeeded but stored only
 * the first 16 sanitized characters with no indication anything was dropped. A key the caller
 * chose on purpose is validated against the real column width instead of silently truncated;
 * only the name-derived fallback keeps the shorter 16-character UX budget.
 */
function validateProjectKey(rawKey: string | undefined): void {
  if (rawKey === undefined || rawKey === null) return;
  const trimmed = String(rawKey).trim();
  if (!trimmed) return; // blank/omitted key falls back to deriving one from the name
  const sanitized = sanitizeKey(trimmed);
  if (!sanitized) throw new BadRequestException({ error: "Project key must contain at least one letter or number" });
  if (sanitized.length > PROJECT_KEY_MAX_LENGTH) {
    throw new BadRequestException({ error: `Project key must be at most ${PROJECT_KEY_MAX_LENGTH} characters` });
  }
}

const PROJECT_NAME_MIN_LENGTH = 3;
// Product-chosen cap, well under the projects.name VARCHAR(255) column — this is a UX/display
// limit, not the column limit.
const PROJECT_NAME_MAX_LENGTH = 30;
const PROJECT_DESCRIPTION_MAX_LENGTH = 500;

// Mirrors AVATAR_COLORS in Tesbo-Frontend/lib/avatarColors.ts. Every swatch there is chosen to clear
// WCAG AA (4.5:1) under white text, so the project icon picker is restricted to this exact palette
// rather than accepting arbitrary hex — the same reasoning that keeps user/team avatars off free-form
// colors. Two copies (frontend picker, backend guard) rather than a shared package, same as
// PROJECT_NAME_MAX_LENGTH above; keep them in sync if the palette ever changes.
const PROJECT_ICON_COLORS = ["#7C5FCC", "#4C5FD5", "#1F7A3D", "#1D7FA8", "#A85F06", "#D83A3A"];

// A custom glyph replaces the auto-derived initial on a project's colored badge — meant for one
// emoji or a couple of typed letters, not a label. Grapheme-counted rather than length-counted so a
// single emoji built from multiple code points (a ZWJ sequence, a skin-tone modifier) still counts
// as one character instead of being rejected as "too long".
const PROJECT_ICON_GLYPH_MAX_GRAPHEMES = 2;
const PROJECT_ICON_GLYPH_MAX_LENGTH = 16;

function countGraphemes(value: string): number {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let count = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const _ of segmenter.segment(value)) count++;
  return count;
}

type ProjectIcon = { color: string | null; glyph: string | null };

/**
 * Validates the optional `icon` override on create/update. `undefined` means the field was not
 * sent at all — leave whatever is stored alone. `null`, or `{ color: null, glyph: null }`, is how a
 * caller explicitly clears back to the generated placeholder (deterministic color + first initial).
 */
function validateProjectIcon(raw: unknown): ProjectIcon | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return { color: null, glyph: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new BadRequestException({ error: "icon must be an object with color and/or glyph" });
  }
  const body = raw as Body;
  let color: string | null = null;
  if (body.color !== undefined && body.color !== null && String(body.color).trim() !== "") {
    const candidate = String(body.color).trim();
    const match = PROJECT_ICON_COLORS.find((c) => c.toLowerCase() === candidate.toLowerCase());
    if (!match) throw new BadRequestException({ error: "Icon color must be one of the supported palette colors" });
    color = match;
  }
  let glyph: string | null = null;
  if (body.glyph !== undefined && body.glyph !== null) {
    const trimmed = String(body.glyph).trim();
    if (trimmed) {
      if (/[\u0000-\u001F\u007F]/.test(trimmed)) {
        throw new BadRequestException({ error: "Icon glyph contains unsupported characters" });
      }
      if (trimmed.length > PROJECT_ICON_GLYPH_MAX_LENGTH || countGraphemes(trimmed) > PROJECT_ICON_GLYPH_MAX_GRAPHEMES) {
        throw new BadRequestException({ error: `Icon glyph must be at most ${PROJECT_ICON_GLYPH_MAX_GRAPHEMES} characters` });
      }
      // Uppercased the same way a project key is: toUpperCase() is a no-op on an emoji or digit, so
      // this only ever changes letters. Normalized server-side too, not just in the picker, so a
      // caller posting directly to the API gets the same badge convention as the UI.
      glyph = trimmed.toUpperCase();
    }
  }
  return { color, glyph };
}

/** Shared by createProject/updateProject. `name`/`description` undefined means "not being changed". */
function validateProjectFields(name: string | undefined, description: string | undefined): void {
  if (name !== undefined) {
    const trimmed = name.trim();
    if (!trimmed) throw new BadRequestException({ error: "Project name is required" });
    if (trimmed.length < PROJECT_NAME_MIN_LENGTH) {
      throw new BadRequestException({ error: `Project name must be at least ${PROJECT_NAME_MIN_LENGTH} characters` });
    }
    if (trimmed.length > PROJECT_NAME_MAX_LENGTH) {
      throw new BadRequestException({ error: `Project name must be at most ${PROJECT_NAME_MAX_LENGTH} characters` });
    }
  }
  if (description !== undefined && description.trim().length > PROJECT_DESCRIPTION_MAX_LENGTH) {
    throw new BadRequestException({ error: `Description must be at most ${PROJECT_DESCRIPTION_MAX_LENGTH} characters` });
  }
}

// Matches the organizations.name VARCHAR(255) column. Same reasoning as PROJECT_NAME_MAX_LENGTH:
// past this the INSERT fails with 22001 `value too long for type character varying(255)`, which
// surfaces to the caller as a 500 on what is really a bad request.
const WORKSPACE_NAME_MAX_LENGTH = 255;

/**
 * Shared by createWorkspace, createOrgAndProject and updateWorkspace, so every path that writes
 * organizations.name is bounded by the column it writes to rather than only the rename path.
 */
function validateWorkspaceName(name: string, field: "orgName" | "name"): string {
  const trimmed = name.trim();
  if (!trimmed) throw new BadRequestException({ error: `${field} is required` });
  if (trimmed.length > WORKSPACE_NAME_MAX_LENGTH) {
    throw new BadRequestException({ error: `Workspace name must be at most ${WORKSPACE_NAME_MAX_LENGTH} characters` });
  }
  return trimmed;
}

/*
 * The bounded VARCHAR columns behind suites, runs, plans and bugs.
 *
 * Nothing validated these, and the consequence was not a policy gap but a 500: Postgres raises
 * 22001 `value too long for type character varying(N)`, nothing here catches it, and the caller gets
 * an unhandled server error on what is plainly a bad request. That is what Basecamp 10217475765
 * ("Geeting error page while creating test suit") actually was — the card carried no repro, and a
 * 900-character suite name reproduces it every time. The same hole was open on runs, plans and bugs,
 * which is the shape docs/basecamp-bugfix-flow.md warns about: one reported column, several
 * unreported ones beside it.
 *
 * Each limit is the column's own width, so these refuse exactly what the INSERT would refuse.
 * Bounds live next to PROJECT_NAME_MAX_LENGTH and WORKSPACE_NAME_MAX_LENGTH, which solved this for
 * projects and workspaces first; this is that pattern finished off.
 */
const SUITE_NAME_MAX_LENGTH = 255;           // suites.name
const CYCLE_NAME_MAX_LENGTH = 255;           // cycles.name
const CYCLE_LABEL_MAX_LENGTH = 128;          // cycles.environment / build_version / release_name
const PLAN_NAME_MAX_LENGTH = 255;            // plans.name
const PLAN_TARGET_RELEASE_MAX_LENGTH = 128;  // plans.target_release
const BUG_TITLE_MAX_LENGTH = 512;            // bugs.title
const BUG_EXTERNAL_URL_MAX_LENGTH = 1024;    // bugs.external_url

/**
 * Refuses a value that would not fit the column it is bound for.
 *
 * `undefined` and `null` mean "not being changed" on the update paths, and every caller here treats
 * an absent field that way (COALESCE), so both pass through untouched. Measured on the trimmed value
 * because that is what the writes store.
 *
 * Note `description` is deliberately absent from every call site below: those columns are TEXT and
 * cannot overflow. Bounding them would be inventing a product rule, and the flow doc records a card
 * that blamed a TEXT description when the real overflow was in a VARCHAR title.
 */
function validateBoundedField(value: unknown, label: string, max: number): void {
  if (value === undefined || value === null) return;
  if (String(value).trim().length > max) {
    throw new BadRequestException({ error: `${label} must be at most ${max} characters` });
  }
}

function maskSecret(value: string): string {
  if (!value) return "********";
  const suffix = value.slice(-4);
  return `${"*".repeat(Math.max(8, Math.min(16, value.length - 4)))}${suffix}`;
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function normalizeJsonArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

// Caps text for display without cutting mid-word/mid-sentence: trims back to the last
// whitespace before maxLength and marks the cut with an ellipsis. A plain `.slice(0, n)`
// reads as a bug (e.g. "...so t") rather than an intentional preview.
function truncateAtWordBoundary(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const cut = value.slice(0, maxLength);
  const lastBoundary = cut.lastIndexOf(" ");
  const trimmed = lastBoundary > maxLength * 0.6 ? cut.slice(0, lastBoundary) : cut;
  return `${trimmed.trimEnd()}…`;
}

// Renders a stored custom field value into the human-readable form used by CSV/XLSX
// export (option ids resolved to their current labels, multi-select joined with ", ").
function formatCustomFieldExportValue(definition: CustomFieldDefinitionDto, raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return "";
  switch (definition.fieldType) {
    case "boolean": {
      const trueFalse = definition.config.displayFormat === "true_false";
      return raw ? (trueFalse ? "True" : "Yes") : trueFalse ? "False" : "No";
    }
    case "single_select": {
      const option = (definition.config.options || []).find((o) => o.id === raw);
      return option?.label || "";
    }
    case "multi_select": {
      const options = definition.config.options || [];
      return (Array.isArray(raw) ? raw : [])
        .map((id) => options.find((o) => o.id === id)?.label || "")
        .filter(Boolean)
        .join(", ");
    }
    case "number":
      return definition.config.unit ? `${raw} ${definition.config.unit}` : String(raw);
    default:
      return String(raw);
  }
}

// Strips path separators/control characters from a folder or document/file name so it's safe
// to use as a zip entry path segment (used only by exportKnowledgeFolder).
function sanitizeZipEntryName(value: string): string {
  const cleaned = value.replace(/[/\\]+/g, "-").replace(/[\x00-\x1f]/g, "").trim();
  return cleaned || "Untitled";
}

function escapeJql(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

type IntegrationProvider = "jira" | "linear";

function assertIntegrationProvider(provider: string): IntegrationProvider {
  if (provider !== "jira" && provider !== "linear") {
    throw new BadRequestException({ error: "Unsupported integration provider." });
  }
  return provider;
}

const JIRA_OAUTH_SCOPE = "read:jira-work read:jira-user write:jira-work offline_access";
const LINEAR_OAUTH_SCOPE = "read,write,issues:create,comments:create";

// ── OAuth `state` signing ──
// Tesbo ships one platform-wide OAuth app per provider, so every workspace shares a single
// client_id and redirect_uri. That makes an opaque `state` unsafe: an attacker who completes their
// own Atlassian consent could hand a workspace owner a link to /integrations/callback carrying the
// attacker's `code`, and the owner's session would happily exchange it — binding the attacker's
// Jira site to the victim's workspace. Signing the state with the workspace id pins the callback to
// the workspace that started it.
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function oauthStateKey(): Buffer {
  // Derived from the secrets key rather than reusing it directly, so a state signature can never
  // be used as an oracle against the AES key that protects stored tokens.
  return createHash("sha256").update(`tesbo:oauth-state:${process.env.SECRETS_ENCRYPTION_KEY || ""}`).digest();
}

function signOAuthState(provider: IntegrationProvider, organizationId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ p: provider, o: organizationId, t: Date.now(), n: randomBytes(8).toString("hex") })
  ).toString("base64url");
  const signature = createHmac("sha256", oauthStateKey()).update(payload).digest("base64url");
  // The provider stays in the clear as the first segment: the callback page reads it to know which
  // provider endpoint to POST back to, before anything has been verified.
  return `${provider}.${payload}.${signature}`;
}

function verifyOAuthState(raw: string, provider: IntegrationProvider, organizationId: string): void {
  const invalid = () => new BadRequestException({ error: "Invalid authorization state. Start the connection again." });
  const parts = String(raw || "").split(".");
  if (parts.length !== 3 || parts[0] !== provider) throw invalid();

  const expected = Buffer.from(createHmac("sha256", oauthStateKey()).update(parts[1]).digest("base64url"));
  const actual = Buffer.from(parts[2]);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalid();

  let claims: Body;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (claims.p !== provider) throw invalid();
  if (claims.o !== organizationId) {
    throw new BadRequestException({ error: "This authorization was started for a different workspace." });
  }
  if (!Number.isFinite(Number(claims.t)) || Date.now() - Number(claims.t) > OAUTH_STATE_TTL_MS) {
    throw new BadRequestException({ error: "This authorization request expired. Start the connection again." });
  }
}

/*
 * Short-lived, unauthenticated links to one Playwright trace.
 *
 * The trace viewer is Playwright's own web app (trace.playwright.dev). It runs entirely in the
 * viewer's browser and reads the .zip with a plain cross-origin `fetch` — no cookies, no custom
 * headers (verified in its bundled service worker: `new HttpReader(url, { mode: "cors",
 * preventHeadRequest: true })`, so there is no HEAD, no Range request and therefore no preflight).
 *
 * That rules out the ordinary evidence download route, which authorizes with the session cookie
 * and 302s to a private presigned S3 URL: a third-party origin fetching it sends no credentials and
 * gets a 401, and the bucket is not public. Hence this token — the caller proves project access
 * once, over the authenticated route, and receives a signed grant that stands alone for TTL.
 *
 * The grant is deliberately narrow: it names a single attachment, it expires, and the route that
 * redeems it re-checks that the file really is a zip. It is a capability URL for exactly one trace
 * archive, which is why nothing that could be rendered as markup can ever travel through it.
 */
const TRACE_LINK_TTL_MS = 60 * 60 * 1000;

function traceLinkKey(): Buffer {
  // Derived rather than reused, for the same reason oauthStateKey() is: a trace signature must not
  // become an oracle against the key protecting stored integration tokens.
  return createHash("sha256").update(`tesbo:trace-link:${process.env.SECRETS_ENCRYPTION_KEY || ""}`).digest();
}

function signTraceLink(attachmentId: string, executionId: string): string {
  const payload = Buffer.from(JSON.stringify({ a: attachmentId, e: executionId, t: Date.now() })).toString("base64url");
  const signature = createHmac("sha256", traceLinkKey()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

/** Throws NotFound — never a 400 — so a tampered token is indistinguishable from a missing file. */
function verifyTraceLink(raw: string): { attachmentId: string; executionId: string } {
  const invalid = () => new NotFoundException({ error: "This trace link is no longer valid" });
  const parts = String(raw || "").split(".");
  if (parts.length !== 2) throw invalid();

  const expected = Buffer.from(createHmac("sha256", traceLinkKey()).update(parts[0]).digest("base64url"));
  const actual = Buffer.from(parts[1]);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalid();

  let claims: Body;
  try {
    claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (!Number.isFinite(Number(claims.t)) || Date.now() - Number(claims.t) > TRACE_LINK_TTL_MS) throw invalid();
  if (!isUuid(claims.a) || !isUuid(claims.e)) throw invalid();
  return { attachmentId: String(claims.a), executionId: String(claims.e) };
}

// ─── AI provider catalog ─────────────────────────────────────────────────────
// Adding a provider is a registry entry, not a new branch. Request code dispatches
// on `wire` alone, and three wires cover everything we support:
//   openai    — POST /v1/chat/completions, GET /v1/models, Authorization: Bearer.
//               Most vendors below are wire-identical to OpenAI and need no code.
//   anthropic — POST /v1/messages, x-api-key + anthropic-version, after_id paging.
//   azure     — OpenAI's body shape, but api-key auth, an api-version query param,
//               and *deployment names* in the path rather than model ids.
type ProviderWire = "openai" | "anthropic" | "azure";

interface ProviderDefinition {
  label: string;
  wire: ProviderWire;
  /** null = use the wire's own default host. A string prefills the settings form. */
  defaultBaseUrl: string | null;
  /** Per-deployment hosts can't be guessed, so the user must supply one. */
  requiresBaseUrl?: boolean;
  /** Local runtimes accept any key, or none at all. */
  optionalApiKey?: boolean;
  /** Seeds the settings form. Empty where only the operator knows the name. */
  defaultModel: string;
  /**
   * Only used when live discovery is unavailable. Deliberately short: a stale id
   * here recreates the retired-model 404 this whole mechanism exists to prevent,
   * and every provider below serves /v1/models, so this is a rarely-taken path.
   */
  fallbackModels: string[];
}

const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-6";
const OPENAI_DEFAULT_MODEL = "gpt-4o";
// Azure pins its data-plane contract by date. Override per key by putting
// ?api-version=... on the stored base URL.
const AZURE_DEFAULT_API_VERSION = "2024-10-21";

const PROVIDER_CATALOG: Record<string, ProviderDefinition> = {
  openai: {
    label: "OpenAI",
    wire: "openai",
    defaultBaseUrl: null,
    defaultModel: OPENAI_DEFAULT_MODEL,
    fallbackModels: [OPENAI_DEFAULT_MODEL, "gpt-4.1", "gpt-4.1-mini"]
  },
  anthropic: {
    label: "Anthropic (Claude)",
    wire: "anthropic",
    defaultBaseUrl: null,
    defaultModel: ANTHROPIC_DEFAULT_MODEL,
    fallbackModels: [ANTHROPIC_DEFAULT_MODEL, "claude-haiku-4-5"]
  },
  google: {
    label: "Google (Gemini)",
    wire: "openai",
    // Gemini's OpenAI-compatible surface, not the native generateContent API —
    // it keeps Gemini on the same wire as everything else.
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.0-flash",
    fallbackModels: []
  },
  groq: {
    label: "Groq",
    wire: "openai",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    fallbackModels: []
  },
  mistral: {
    label: "Mistral",
    wire: "openai",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-large-latest",
    fallbackModels: []
  },
  deepseek: {
    label: "DeepSeek",
    wire: "openai",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    fallbackModels: []
  },
  xai: {
    label: "xAI (Grok)",
    wire: "openai",
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultModel: "",
    fallbackModels: []
  },
  openrouter: {
    label: "OpenRouter",
    wire: "openai",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    // OpenRouter addresses models as vendor/model across hundreds of options,
    // so discovery matters more here than a seeded default.
    defaultModel: "",
    fallbackModels: []
  },
  together: {
    label: "Together AI",
    wire: "openai",
    defaultBaseUrl: "https://api.together.xyz/v1",
    defaultModel: "",
    fallbackModels: []
  },
  fireworks: {
    label: "Fireworks AI",
    wire: "openai",
    defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
    defaultModel: "",
    fallbackModels: []
  },
  ollama: {
    label: "Ollama (self-hosted)",
    wire: "openai",
    defaultBaseUrl: "http://localhost:11434/v1",
    optionalApiKey: true,
    defaultModel: "",
    fallbackModels: []
  },
  lmstudio: {
    label: "LM Studio (self-hosted)",
    wire: "openai",
    defaultBaseUrl: "http://localhost:1234/v1",
    optionalApiKey: true,
    defaultModel: "",
    fallbackModels: []
  },
  vllm: {
    label: "vLLM (self-hosted)",
    wire: "openai",
    defaultBaseUrl: "http://localhost:8000/v1",
    optionalApiKey: true,
    defaultModel: "",
    fallbackModels: []
  },
  "azure-openai": {
    label: "Azure OpenAI",
    wire: "azure",
    // https://<resource>.openai.azure.com — per-resource, so it can't be defaulted.
    defaultBaseUrl: null,
    requiresBaseUrl: true,
    // Azure routes by deployment name, which the operator chooses; there is no
    // meaningful default and discovery returns deployments rather than model ids.
    defaultModel: "",
    fallbackModels: []
  }
};

function providerDefinition(provider: string): ProviderDefinition | null {
  return PROVIDER_CATALOG[String(provider || "").trim().toLowerCase()] || null;
}

/** Unknown providers are user-defined gateways, which are OpenAI-wire by convention. */
function providerWire(provider: string): ProviderWire {
  return providerDefinition(provider)?.wire || "openai";
}

function isCatalogProvider(provider: string): boolean {
  return providerDefinition(provider) !== null;
}

/** The effective base URL: an explicit override, else the catalog default. */
function resolveProviderBaseUrl(provider: string, storedBaseUrl?: string | null): string | null {
  const explicit = String(storedBaseUrl || "").trim();
  if (explicit) return trimTrailingSlashes(explicit);
  return providerDefinition(provider)?.defaultBaseUrl ?? null;
}

function normalizeProviderModel(provider: string, model?: string | null): string {
  const value = String(model || "").trim();
  if (providerWire(provider) === "anthropic") {
    const aliases: Record<string, string> = {
      "": ANTHROPIC_DEFAULT_MODEL,
      "claude-sonnet": ANTHROPIC_DEFAULT_MODEL,
      "claude-sonnet-4": ANTHROPIC_DEFAULT_MODEL,
      "claude-4-sonnet": ANTHROPIC_DEFAULT_MODEL,
      "sonnet": ANTHROPIC_DEFAULT_MODEL,
      "sonnet-4": ANTHROPIC_DEFAULT_MODEL,
      "claude-sonnet-4-20250514": ANTHROPIC_DEFAULT_MODEL,
      // Retired snapshots — Anthropic 404s these ("model: <id>"), so remap rather
      // than pass them through: workspaces that saved one before it was retired
      // keep working instead of failing every AI call.
      "claude-3.5-sonnet": ANTHROPIC_DEFAULT_MODEL,
      "claude-3-5-sonnet": ANTHROPIC_DEFAULT_MODEL,
      "claude-3-5-sonnet-20241022": ANTHROPIC_DEFAULT_MODEL,
      "claude-3-7-sonnet": ANTHROPIC_DEFAULT_MODEL,
      "claude-3-7-sonnet-20250219": ANTHROPIC_DEFAULT_MODEL
    };
    return aliases[value.toLowerCase()] || value;
  }
  return value || providerDefinition(provider)?.defaultModel || OPENAI_DEFAULT_MODEL;
}

function providerModelCandidates(provider: string, model?: string | null): string[] {
  const normalized = normalizeProviderModel(provider, model);
  // Every entry must be a currently-served model. A retired id burns a candidate
  // slot on a guaranteed 404 and, because the retry loop only reports the *last*
  // status, buries the real failure behind "model: <retired id>".
  const seed = providerDefinition(provider)?.defaultModel || "";
  return Array.from(new Set([normalized, seed].filter(Boolean)));
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function normalizeChatCompletionsUrl(baseUrl?: string | null): string {
  const value = String(baseUrl || "").trim();
  if (!value) return "https://api.openai.com/v1/chat/completions";
  const trimmed = trimTrailingSlashes(value);
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function normalizeAudioTranscriptionsUrl(baseUrl?: string | null): string {
  const value = String(baseUrl || "").trim();
  if (!value) return "https://api.openai.com/v1/audio/transcriptions";
  const trimmed = trimTrailingSlashes(value);
  if (trimmed.endsWith("/audio/transcriptions")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/audio/transcriptions`;
  return `${trimmed}/v1/audio/transcriptions`;
}

function normalizeAnthropicMessagesUrl(baseUrl?: string | null): string {
  const value = String(baseUrl || "").trim();
  if (!value) return "https://api.anthropic.com/v1/messages";
  const trimmed = trimTrailingSlashes(value);
  if (trimmed.endsWith("/messages")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
}

function normalizeModelsListUrl(provider: string, baseUrl?: string | null): string {
  const resolved = resolveProviderBaseUrl(provider, baseUrl);
  if (providerWire(provider) === "azure") {
    // Azure serves deployments, not model ids — a deployment name is what the chat
    // path actually addresses, so that list is the one worth showing.
    return azureDataPlaneUrl(resolved || "", "deployments");
  }
  if (!resolved) {
    return providerWire(provider) === "anthropic"
      ? "https://api.anthropic.com/v1/models"
      : "https://api.openai.com/v1/models";
  }
  if (resolved.endsWith("/models")) return resolved;
  if (resolved.endsWith("/v1")) return `${resolved}/models`;
  return `${resolved}/v1/models`;
}

// Azure addresses everything under /openai on a per-resource host and requires an
// api-version on every data-plane call. Honour one already present on the stored
// base URL so a workspace can pin a contract version without a schema change.
function azureDataPlaneUrl(baseUrl: string, suffix: string): string {
  const [rawRoot, rawQuery = ""] = String(baseUrl || "").split("?");
  const params = new URLSearchParams(rawQuery);
  if (!params.get("api-version")) params.set("api-version", AZURE_DEFAULT_API_VERSION);
  const root = trimTrailingSlashes(rawRoot).replace(/\/openai$/, "");
  return `${root}/openai/${suffix}?${params.toString()}`;
}

function providerFallbackModels(provider: string): string[] {
  return providerDefinition(provider)?.fallbackModels || [];
}

/**
 * Chat endpoint for the OpenAI and Azure wires. `model` is only consulted for Azure,
 * which routes by deployment name in the path rather than by a body field.
 * The anthropic wire has its own endpoint — see normalizeAnthropicMessagesUrl.
 */
function providerChatUrl(provider: string, baseUrl?: string | null, model?: string): string {
  const resolved = resolveProviderBaseUrl(provider, baseUrl);
  if (providerWire(provider) === "azure") {
    return azureDataPlaneUrl(resolved || "", `deployments/${encodeURIComponent(String(model || ""))}/chat/completions`);
  }
  return normalizeChatCompletionsUrl(resolved);
}

function normalizeAnthropicMessagesUrlFor(provider: string, baseUrl?: string | null): string {
  return normalizeAnthropicMessagesUrl(resolveProviderBaseUrl(provider, baseUrl));
}

// /v1/models returns every served model, including embeddings, audio and image
// endpoints that can't answer a chat request. Keep only the conversational ones.
//
// The exclusion list is provider-agnostic and safe everywhere. The positive allowlist
// is NOT: it encodes OpenAI's own naming, so it may only be applied to OpenAI itself.
// Every other OpenAI-wire provider names models freely (llama-3.3-70b-versatile,
// mistral-large, deepseek-chat), and matching them against gpt/o-series prefixes
// would filter the entire catalogue away and report "no chat-capable models".
function isChatCapableModelId(provider: string, id: string): boolean {
  const value = id.toLowerCase();
  if (providerWire(provider) === "anthropic") return value.startsWith("claude");
  if (/embedding|audio|realtime|image|tts|whisper|moderation|transcribe|rerank|dall-e|guard/.test(value)) return false;
  return provider === "openai" ? /^(gpt|o[1-4]|chatgpt)/.test(value) : true;
}

@Injectable()
export class LegacyService implements OnModuleInit {
  private readonly logger = new Logger(LegacyService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly email: EmailService,
    private readonly password: PasswordService,
    private readonly config: AppConfigService,
    private readonly storage: StorageService,
    private readonly ragIngestion: RagIngestionService,
    private readonly ragRetrieval: RagRetrievalService,
    private readonly integrationSync: IntegrationSyncService,
    private readonly apiTokens: ApiTokenService,
    private readonly planLimits: PlanLimitsService,
    @Inject(forwardRef(() => CustomFieldsService)) private readonly customFields: CustomFieldsService
  ) {}

  // --- API tokens (project-scoped machine credentials) -------------------
  // Backs GET/POST/DELETE /api/projects/:id/apikeys. Access is gated by the
  // same project-membership check used across the rest of the API.

  async listApiKeys(userId: string | null | undefined, projectId: string) {
    await this.requireProjectAccess(userId, projectId);
    return this.apiTokens.listTokens(projectId);
  }

  async createApiKey(userId: string | null | undefined, projectId: string, body: Body) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    const name = String(body?.name || "").trim();
    if (!name) throw new BadRequestException({ error: "name is required" });
    return this.apiTokens.issueToken(uid, projectId, name, body?.scopes);
  }

  async revokeApiKey(userId: string | null | undefined, projectId: string, keyId: string) {
    await this.requireProjectAccess(userId, projectId);
    if (!isUuid(keyId)) throw new NotFoundException({ error: "API key not found" });
    const removed = await this.apiTokens.revokeToken(projectId, keyId);
    if (!removed) throw new NotFoundException({ error: "API key not found" });
    return { ok: true };
  }

  private enqueueEmbedding(organizationId: string, projectId: string, sourceType: "document" | "file", sourceId: string, reason: "created" | "updated" | "transcribed"): void {
    void this.ragIngestion.enqueueEmbedding({ organizationId, projectId, sourceType, sourceId, reason }).catch(() => undefined);
  }

  async onModuleInit(): Promise<void> {
    this.resumeInterruptedZyraChatPlans().catch((err) => {
      this.logger.warn(`Failed to resume Zyra chat plans on startup: ${err instanceof Error ? err.message : err}`);
    });
  }

  // A backend restart kills any in-flight continueZyraChatPlan loop instantly — it's an
  // in-memory fire-and-forget task, not a durable job — leaving the session's active_plan
  // set with no further batches ever posting and no error message, until the user happens
  // to send an unrelated message (which just cancels it as a side effect). Resume every
  // plan that was genuinely still running (not one a user or a graceful error already
  // paused — those wait for an explicit "continue") once at boot so a deploy/crash mid-plan
  // self-heals instead of stalling silently.
  private async resumeInterruptedZyraChatPlans(): Promise<void> {
    const res = await this.db.query(
      "SELECT id, project_id, user_id, active_plan FROM zyra_chat_sessions WHERE active_plan IS NOT NULL AND active_plan->>'status' = 'running'"
    ).catch(() => ({ rows: [] as Body[] }));
    for (const row of res.rows) {
      const plan = row.active_plan as Body | null;
      const planId = plan?.planId ? String(plan.planId) : "";
      if (!planId) continue;
      this.logger.log(`Resuming interrupted Zyra chat plan for session ${row.id} (${Number(plan?.doneCount) || 0}/${Number(plan?.totalCount) || 0} done)`);
      void this.continueZyraChatPlan(String(row.project_id), row.user_id ? String(row.user_id) : null, String(row.id), planId).catch(() => undefined);
    }
  }

  /**
   * "There is a signed-in caller" on its own, for routes with nothing else to authorize against.
   *
   * requireUser is private; this is the same check exposed for the notification routes, which have no
   * project or workspace in their URL to resolve.
   */
  requireSession(userId?: string | null): string {
    return this.requireUser(userId);
  }

  private requireUser(userId?: string | null): string {
    if (!userId) throw new BadRequestException({ error: "Authentication required" });
    return userId;
  }

  private async requirePlatformAdmin(userId?: string | null): Promise<string> {
    const uid = this.requireUser(userId);
    const result = await this.db.query("SELECT 1 FROM platform_admins WHERE user_id = $1 LIMIT 1", [uid]);
    if (!result.rows[0]) throw new ForbiddenException({ error: "Platform admin access required" });
    return uid;
  }

  async logProjectActivity(projectId: string, actorId: string | null, action: string, entityType: string, entityId: string | null, entityName: string | null, diff: Body) {
    await this.db.query(
      `INSERT INTO audit_logs (project_id, actor_id, action, entity_type, entity_id, entity_name, diff, organization_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb, (SELECT organization_id FROM projects WHERE id = $1))`,
      [projectId, actorId, action, entityType, entityId, entityName, JSON.stringify(diff)]
    ).catch(() => undefined);
  }

  // Sibling to logProjectActivity for pure workspace-level events with no project
  // context (membership/invite lifecycle) — project_id stays NULL.
  async logWorkspaceActivity(organizationId: string, actorId: string | null, action: string, entityType: string, entityId: string | null, entityName: string | null, diff: Body) {
    await this.db.query(
      `INSERT INTO audit_logs (organization_id, actor_id, action, entity_type, entity_id, entity_name, diff)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [organizationId, actorId, action, entityType, entityId, entityName, JSON.stringify(diff)]
    ).catch(() => undefined);
  }

  // Cached lookup for the well-known Zyra agent's actor id — resolved once and reused, since
  // this never changes at runtime. Used to attribute testcase mutations to Zyra itself on any
  // code path that has no originating human request in scope (e.g. a resumed background plan).
  private zyraActorIdPromise: Promise<string | null> | null = null;
  private async getZyraActorId(): Promise<string | null> {
    if (!this.zyraActorIdPromise) {
      this.zyraActorIdPromise = this.db
        .query<{ id: string }>("SELECT a.id FROM actors a JOIN agents g ON g.id = a.id WHERE g.slug = 'zyra'")
        .then((res) => res.rows[0]?.id || null)
        .catch(() => null);
    }
    return this.zyraActorIdPromise;
  }

  // Resolves the actor to attribute a Zyra-driven mutation to: the real human user when one
  // originated the request, otherwise Zyra's own agent actor id.
  private async resolveZyraActor(userId: string | null): Promise<string | null> {
    return userId || (await this.getZyraActorId());
  }

  private async zyraAiAllocation(projectId: string): Promise<{ key: Body | null; reason: string }> {
    const allocation = await this.db.query(
      `SELECT k.id, k.name, k.provider, k.default_model, k.base_url, k.auth_header_name, k.auth_scheme, k.is_active, k.api_key
       FROM project_ai_key_allocations a
       JOIN workspace_ai_keys k ON k.id = a.workspace_ai_key_id
       WHERE a.project_id = $1`,
      [projectId]
    );
    const key = allocation.rows[0] || null;
    if (key?.is_active) return { key, reason: "Workspace AI key allocated to this project." };
    if (key && !key.is_active) return { key: null, reason: `AI key "${key.name}" is allocated to this project but is inactive.` };

    const project = await this.db.query("SELECT organization_id FROM projects WHERE id = $1", [projectId]);
    const organizationId = project.rows[0]?.organization_id;
    if (!organizationId) return { key: null, reason: "Project was not found while checking AI key allocation." };
    const workspaceKeys = await this.db.query(
      `SELECT provider, COUNT(*)::int AS count
       FROM workspace_ai_keys
       WHERE organization_id = $1 AND is_active = true
       GROUP BY provider`,
      [organizationId]
    );
    if (workspaceKeys.rows.length) {
      const providers = workspaceKeys.rows.map((row) => `${row.provider} (${row.count})`).join(", ");
      return { key: null, reason: `Active workspace AI key(s) exist (${providers}), but none is allocated to this project.` };
    }
    return { key: null, reason: "No active workspace AI key is available for this project." };
  }

  private buildAnthropicAuthHeaders(apiKey: string, authHeaderName: string | null, authScheme: string | null): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01"
    };
    // Strip any accidental "Bearer " prefix that may have been stored with the key
    const cleanKey = String(apiKey || "").replace(/^bearer\s+/i, "").trim();
    // "Authorization" is the legacy DB default for known providers — treat it the same as null.
    // Only respect a custom header name when the user explicitly set something non-standard.
    const hasCustomHeader = authHeaderName && authHeaderName.toLowerCase() !== "authorization";
    if (hasCustomHeader) {
      const scheme = authScheme ? String(authScheme).trim() : "";
      headers[String(authHeaderName)] = scheme ? `${scheme} ${cleanKey}` : cleanKey;
    } else {
      headers["x-api-key"] = cleanKey;
    }
    return headers;
  }

  // Single place that knows how each wire authenticates. Custom providers keep their
  // explicit header/scheme overrides; catalog providers get their wire's convention.
  private providerAuthHeaders(provider: string, apiKey: string, authHeaderName: string | null, authScheme: string | null): Record<string, string> {
    const wire = providerWire(provider);
    if (wire === "anthropic") return this.buildAnthropicAuthHeaders(apiKey, authHeaderName, authScheme);
    if (wire === "azure") {
      // Azure authenticates with a bare api-key header — not Bearer.
      return { "Content-Type": "application/json", [authHeaderName || "api-key"]: apiKey };
    }
    return this.buildBearerAuthHeaders(apiKey, authHeaderName, authScheme);
  }

  private isProviderAuthError(status: number, message?: string): boolean {
    if (status === 401 || status === 403) return true;
    return /invalid x-api-key|authentication_error|invalid[_ ]api[_ ]key|incorrect api key|unauthorized|permission_error|forbidden/i.test(String(message || ""));
  }

  // Turn a raw provider HTTP failure into a clear, actionable message for the user.
  // Returns "" when the failure isn't a recognized auth/permission/rate-limit case.
  private describeProviderError(provider: string, status: number, rawMessage?: string): string {
    const label = providerDefinition(provider)?.label || provider || "AI provider";
    const message = String(rawMessage || "");
    if (status === 401 || /invalid x-api-key|authentication_error|invalid[_ ]api[_ ]key|incorrect api key|unauthorized/i.test(message)) {
      return `The ${label} API key is invalid or has been revoked. Update it in Workspace → Integrations, then use "Test connection" to verify.`;
    }
    if (status === 403 || /permission_error|forbidden|does not have access|not allowed/i.test(message)) {
      return `The ${label} API key was rejected for permissions — check the account's plan, billing, or model access, then update the key in Workspace → Integrations.`;
    }
    if (status === 429 || /rate.?limit|overloaded|quota|insufficient_quota/i.test(message)) {
      return `${label} is rate-limited or out of quota right now. Wait a moment and retry, or check the account's usage limits.`;
    }
    return "";
  }

  // Pull a clean, user-facing message out of any thrown error (incl. Nest HttpException payloads).
  private extractAiErrorMessage(err: unknown): string {
    const anyErr = err as { getResponse?: () => unknown; message?: string };
    if (anyErr && typeof anyErr.getResponse === "function") {
      const resp = anyErr.getResponse();
      if (resp && typeof resp === "object") {
        const obj = resp as Record<string, unknown>;
        return String(obj.error || obj.message || anyErr.message || "AI request failed.");
      }
      if (typeof resp === "string") return resp;
    }
    return err instanceof Error ? err.message : String(err);
  }

  async createWorkspace(userId: string | null | undefined, body: Body) {
    const uid = this.requireUser(userId);
    const name = validateWorkspaceName(String(body.orgName || body.name || ""), "orgName");
    const res = await this.db.transaction(async (client) => {
      const organizationId = await insertOrganization(client, name, normalizeCountryCode(body.country));
      await client.query(
        "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING",
        [organizationId, uid]
      );
      await client.query("UPDATE users SET active_organization_id = $1, updated_at = now() WHERE id = $2", [
        organizationId,
        uid
      ]);
      return organizationId;
    });
    return { organizationId: res };
  }

  async createOrgAndProject(userId: string | null | undefined, body: Body) {
    const uid = this.requireUser(userId);
    const orgName = String(body.orgName || "").trim();
    const name = String(body.projectName || body.name || "").trim();
    if (!orgName || !name) throw new BadRequestException({ error: "orgName and projectName are required" });
    validateWorkspaceName(orgName, "orgName");
    const key = projectKey(String(body.projectKey || name));
    return this.db.transaction(async (client) => {
      const organizationId = await insertOrganization(client, orgName, normalizeCountryCode(body.country));
      await client.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')", [
        organizationId,
        uid
      ]);
      const project = await client.query<{ id: string }>(
        `INSERT INTO projects (organization_id, key, name, description)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [organizationId, key, name, body.projectDescription || body.description || ""]
      );
      await client.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')", [
        project.rows[0].id,
        uid
      ]);
      // The same seeding createProject does. Without it the workspace's FIRST project — the one
      // every new signup lands in — has no knowledge_folders root, and the whole Knowledge Base is
      // unusable there: the folder tree 404s ("root folder not found") and createKnowledgeFolder
      // falls back to parent_folder_id = NULL, quietly making a second orphan root.
      await this.seedKnowledgeBaseDefaults(client, organizationId, project.rows[0].id);
      await client.query("UPDATE users SET default_project_id = $1, updated_at = now() WHERE id = $2", [project.rows[0].id, uid]);
      return { organizationId, projectId: project.rows[0].id, projectKey: key };
    });
  }

  async workspace(userId: string | null | undefined) {
    const uid = this.requireUser(userId);

    const active = await this.db.query(
      `SELECT o.id, o.name, o.slug, o.plan, o.country, om.role, o.created_at
       FROM users u
       JOIN organizations o ON o.id = u.active_organization_id
       JOIN organization_members om ON om.organization_id = o.id AND om.user_id = u.id
       WHERE u.id = $1`,
      [uid]
    );
    if (active.rows[0]) return toCamel(active.rows[0]);

    // active_organization_id is unset or stale (e.g. user was removed from
    // that org) — fall back to the earliest membership and self-heal.
    const res = await this.db.query(
      `SELECT o.id, o.name, o.slug, o.plan, o.country, om.role, o.created_at
       FROM organizations o
       JOIN organization_members om ON om.organization_id = o.id
       WHERE om.user_id = $1
       ORDER BY o.created_at ASC LIMIT 1`,
      [uid]
    );
    if (!res.rows[0]) throw new NotFoundException({ error: "Workspace not found" });
    try {
      await this.db.query("UPDATE users SET active_organization_id = $1, updated_at = now() WHERE id = $2", [
        res.rows[0].id,
        uid
      ]);
    } catch {
      // Non-fatal: still return the resolved workspace even if the self-heal write fails.
    }
    return toCamel(res.rows[0]);
  }

  async listWorkspaces(userId: string | null | undefined) {
    const uid = this.requireUser(userId);
    const res = await this.db.query(
      `SELECT o.id, o.name, o.slug, o.plan, om.role, (o.id = u.active_organization_id) AS is_active
       FROM organizations o
       JOIN organization_members om ON om.organization_id = o.id
       JOIN users u ON u.id = om.user_id
       WHERE om.user_id = $1
       ORDER BY o.created_at ASC`,
      [uid]
    );
    return res.rows.map(toCamel);
  }

  async switchWorkspace(userId: string | null | undefined, organizationId: string) {
    const uid = this.requireUser(userId);
    const member = await this.db.query(
      "SELECT organization_id FROM organization_members WHERE organization_id = $1 AND user_id = $2",
      [organizationId, uid]
    );
    if (!member.rows[0]) throw new ForbiddenException({ error: "You are not a member of this workspace" });
    await this.db.query("UPDATE users SET active_organization_id = $1, updated_at = now() WHERE id = $2", [
      organizationId,
      uid
    ]);
    return this.workspace(uid);
  }

  async updateWorkspace(userId: string | null | undefined, body: Body) {
    const uid = this.requireUser(userId);
    const workspace = await this.workspace(uid);
    const callerRole = this.normalizeRole(workspace.role);
    if (callerRole === "qa_engineer")
      throw new ForbiddenException({ error: "Only workspace owners and managers can rename the workspace" });

    const name = validateWorkspaceName(String(body.name || ""), "name");

    // `country` is optional here so a plain rename doesn't clear it; passing "" clears it explicitly.
    const country = body.country === undefined ? undefined : normalizeCountryCode(body.country);
    await this.db.query(
      `UPDATE organizations SET name = $1, country = CASE WHEN $3 THEN $2 ELSE country END, updated_at = now() WHERE id = $4`,
      [name, country, country !== undefined, workspace.id]
    );
    return this.workspace(uid);
  }

  async workspaceMembers(userId: string | null | undefined) {
    const workspace = await this.workspace(userId);
    const res = await this.db.query(
      `SELECT u.id AS user_id, u.email, COALESCE(u.name, '') AS name, om.role, om.created_at AS joined_at
       FROM organization_members om JOIN users u ON u.id = om.user_id
       WHERE om.organization_id = $1 ORDER BY u.email`,
      [workspace.id]
    );
    return res.rows.map(toCamel);
  }

  /**
   * The settings screen's project-access matrix: the projects the caller administers, every
   * workspace member, and the project role each member actually holds.
   *
   * Owner-and-manager only. It is the same roster the membership screens are gated on, and it also
   * discloses which projects exist to someone who may be a member of none of them.
   */
  async workspaceProjectAccess(userId: string | null | undefined) {
    const uid = this.requireUser(userId);
    const workspace = await this.workspace(uid);
    if (this.normalizeRole(workspace.role) === "qa_engineer")
      throw new ForbiddenException({ error: "Only workspace owners and managers can view project access" });

    const projects = await this.listProjects(uid);
    const members = await this.workspaceMembers(uid);
    const projectIds = projects.map((p) => String(p.id));

    // Scoped to the projects the caller can already see, so the matrix never reveals a role on a
    // project they have no access to themselves.
    const assignments = projectIds.length
      ? await this.db.query<{ user_id: string; project_id: string; role: string }>(
          "SELECT user_id, project_id, role FROM project_members WHERE project_id = ANY($1::uuid[])",
          [projectIds]
        )
      : { rows: [] as { user_id: string; project_id: string; role: string }[] };

    const rolesByUser = new Map<string, Record<string, string>>();
    for (const row of assignments.rows) {
      const roles = rolesByUser.get(row.user_id) ?? {};
      roles[row.project_id] = this.normalizeRole(row.role);
      rolesByUser.set(row.user_id, roles);
    }

    // A member with no project access gets an empty map rather than a missing key, so "no access"
    // is distinguishable from "roles weren't loaded" — which is exactly what the hard-coded `{}`
    // this replaced made impossible.
    return {
      projects,
      members: members.map((m) => ({ ...m, projectRoles: rolesByUser.get(String(m.userId)) ?? {} }))
    };
  }

  async addWorkspaceMember(userId: string | null | undefined, body: Body) {
    const uid = this.requireUser(userId);
    const workspace = await this.workspace(uid);
    // Adding a member outright is strictly more powerful than inviting one, so this endpoint cannot
    // be looser than createInvitation: QA engineers are refused, a manager can only add QA
    // engineers, and nobody grants owner. changeWorkspaceMemberRole already refuses promotion to
    // owner — a gate only one of the two endpoints enforces is decoration.
    const callerRole = this.normalizeRole(workspace.role);
    if (callerRole === "qa_engineer")
      throw new ForbiddenException({ error: "QA Engineers cannot add team members" });

    const email = String(body.email || "").trim().toLowerCase();
    const target = String(body.userId || "").trim();
    if (!email && !target) throw new BadRequestException({ error: "email or userId is required" });
    if (target && !isUuid(target)) throw new BadRequestException({ error: "userId is not a valid user id" });

    const roleRaw = body.role === undefined || body.role === null || body.role === "" ? "qa_engineer" : body.role;
    const role = this.parseRole(roleRaw);
    if (!role) throw new BadRequestException({ error: `"${String(roleRaw)}" is not a role in this workspace` });
    if (role === "owner") throw new ForbiddenException({ error: "The owner role cannot be granted" });
    if (callerRole === "manager" && role !== "qa_engineer")
      throw new ForbiddenException({ error: "Managers can only add QA Engineers" });

    const targetUserId = target || (await this.upsertUser(email));
    if (target) {
      // Adding by id skips upsertUser, so an id for an account that doesn't exist would only fail
      // at the foreign key — a 500 where the caller should be told the user isn't there.
      const exists = await this.db.query("SELECT 1 FROM users WHERE id = $1", [target]);
      if (!exists.rows[0]) throw new NotFoundException({ error: "User not found" });
    }
    await this.db.query(
      "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role",
      [workspace.id, targetUserId, role]
    );
    await this.logWorkspaceActivity(workspace.id, uid, "workspace_member_added", "workspace_member", targetUserId, email || targetUserId, { role });
  }

  async removeWorkspaceMember(userId: string | null | undefined, targetUserId: string) {
    const uid = this.requireUser(userId);
    const workspace = await this.workspace(uid);
    if (uid === targetUserId) throw new BadRequestException({ error: "You cannot remove yourself" });
    if (!isUuid(targetUserId)) throw new BadRequestException({ error: "userId is not a valid user id" });
    // Protect the last owner
    const targetMember = await this.db.query<{ role: string; email: string }>(
      `SELECT om.role, u.email FROM organization_members om JOIN users u ON u.id = om.user_id
       WHERE om.organization_id = $1 AND om.user_id = $2`,
      [workspace.id, targetUserId]
    );
    if (!targetMember.rows[0]) throw new NotFoundException({ error: "Member not found" });
    if (targetMember.rows[0].role === "owner") {
      const ownerCount = await this.db.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM organization_members WHERE organization_id = $1 AND role = 'owner'",
        [workspace.id]
      );
      if (Number(ownerCount.rows[0].count) <= 1)
        throw new BadRequestException({ error: "Cannot remove the last owner" });
    }
    // Only owner can remove members; manager cannot remove members (per spec)
    const callerRole = this.normalizeRole(workspace.role);
    if (callerRole !== "owner") throw new ForbiddenException({ error: "Only the owner can remove team members" });
    await this.db.transaction(async (client) => {
      await client.query("DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2", [workspace.id, targetUserId]);
      // A workspace-level removal must also drop the user from every project in this
      // workspace — otherwise they keep showing up as a project member (and keep project
      // access) despite no longer being part of the workspace at all.
      await client.query(
        "DELETE FROM project_members WHERE user_id = $2 AND project_id IN (SELECT id FROM projects WHERE organization_id = $1)",
        [workspace.id, targetUserId]
      );
    });
    await this.logWorkspaceActivity(workspace.id, uid, "workspace_member_removed", "workspace_member", targetUserId, targetMember.rows[0].email, { role: targetMember.rows[0].role });
  }

  // ─── Role helpers ────────────────────────────────────────────────────────────

  hashToken(raw: string): string {
    return createHash("sha256").update(raw).digest("hex");
  }

  async getInvitationRowOrThrow(rawToken: string): Promise<InvitationRow> {
    const tokenHash = this.hashToken(rawToken);
    const invite = await this.db.query<InvitationRow>(
      "SELECT id, organization_id, email, role, status, expires_at, project_ids FROM invitations WHERE token = $1",
      [tokenHash]
    );
    if (!invite.rows[0]) throw new NotFoundException({ error: "Invitation not found or token is invalid" });
    const inv = invite.rows[0];

    if (inv.status !== "pending") throw new BadRequestException({ error: `Invitation is ${inv.status} and can no longer be used` });
    if (new Date(inv.expires_at) < new Date()) {
      await this.db.query("UPDATE invitations SET status = 'expired', updated_at = now() WHERE id = $1", [inv.id]);
      throw new BadRequestException({ error: "This invitation has expired. Ask the sender to resend it." });
    }
    return inv;
  }

  normalizeRole(role: string): "owner" | "manager" | "qa_engineer" {
    const n = (role ?? "").trim().toLowerCase().replace(/-/g, "_").replace(/ /g, "_");
    if (n === "owner") return "owner";
    if (n === "manager" || n === "admin" || n === "test_manager") return "manager";
    return "qa_engineer";
  }

  /**
   * The canonical role for a string supplied by a *caller*, or null when it isn't a role we have.
   *
   * normalizeRole() collapses anything unrecognised to qa_engineer. That is the right reading for a
   * role already stored in the database, but the wrong one for input: a typo'd role in a promotion
   * request would silently DEMOTE the member instead of failing, and an unknown role written
   * verbatim to organization_members reads back as qa_engineer on every later check. Anything that
   * takes a role from a request body parses it here and refuses null.
   */
  parseRole(role: unknown): "owner" | "manager" | "qa_engineer" | null {
    const n = String(role ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_");
    if (n === "owner") return "owner";
    if (n === "manager" || n === "admin" || n === "test_manager") return "manager";
    if (n === "qa_engineer" || n === "qa" || n === "tester" || n === "member") return "qa_engineer";
    return null;
  }

  // ─── Invitations ─────────────────────────────────────────────────────────────

  async createInvitation(userId: string | null | undefined, body: Body) {
    const uid = this.requireUser(userId);
    const workspace = await this.workspace(uid);
    const callerRole = this.normalizeRole(workspace.role);

    const email = String(body.email || "").trim().toLowerCase();
    const roleRaw = String(body.role || "qa_engineer");
    const role = this.normalizeRole(roleRaw);
    const projectIds: string[] = Array.isArray(body.projectIds) ? body.projectIds.filter(Boolean) : [];

    if (!email) throw new BadRequestException({ error: "email is required" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new BadRequestException({ error: "invalid email address" });

    // Permission checks
    if (callerRole === "qa_engineer") throw new ForbiddenException({ error: "QA Engineers cannot invite members" });
    if (role === "owner") throw new ForbiddenException({ error: "Cannot invite owners directly" });
    if (callerRole === "manager" && role !== "qa_engineer")
      throw new ForbiddenException({ error: "Managers can only invite QA Engineers" });

    // Already a member?
    const existing = await this.db.query(
      `SELECT om.user_id FROM organization_members om
       JOIN users u ON u.id = om.user_id
       WHERE om.organization_id = $1 AND lower(u.email) = $2`,
      [workspace.id, email]
    );
    if (existing.rows[0]) throw new BadRequestException({ error: "This user is already a team member" });

    // Pending invite already exists?
    const pending = await this.db.query<{ id: string }>(
      "SELECT id FROM invitations WHERE organization_id = $1 AND email = $2 AND status = 'pending'",
      [workspace.id, email]
    );
    if (pending.rows[0])
      throw new BadRequestException({
        error: "This email already has a pending invite. You can resend the invite.",
        inviteId: pending.rows[0].id
      });

    // Validate project IDs belong to this workspace
    if (projectIds.length > 0) {
      const valid = await this.db.query<{ id: string }>(
        "SELECT id FROM projects WHERE id = ANY($1::uuid[]) AND organization_id = $2 AND archived_at IS NULL",
        [projectIds, workspace.id]
      );
      if (valid.rows.length !== projectIds.length)
        throw new BadRequestException({ error: "One or more project IDs are invalid" });
    }

    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const result = await this.db.query(
      `INSERT INTO invitations (organization_id, email, role, token, invited_by, status, expires_at, project_ids)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
       RETURNING id, email, role, status, expires_at, created_at, project_ids`,
      [workspace.id, email, role, tokenHash, uid, expiresAt, projectIds]
    );

    const inviter = await this.db.query<{ name: string | null; email: string }>(
      "SELECT name, email FROM users WHERE id = $1",
      [uid]
    );
    const inviterName = inviter.rows[0]?.name || inviter.rows[0]?.email || "A team member";

    let projectNames: string[] = [];
    if (projectIds.length > 0) {
      const projs = await this.db.query<{ name: string }>(
        "SELECT name FROM projects WHERE id = ANY($1::uuid[])",
        [projectIds]
      );
      projectNames = projs.rows.map((r) => r.name);
    }

    await this.email.sendInvite(email, inviterName, role, workspace.name, rawToken, projectNames, this.config.frontendUrl);

    await this.logWorkspaceActivity(workspace.id, uid, "invitation_sent", "invitation", result.rows[0].id, email, { role, projectIds });

    return toCamel(result.rows[0]);
  }

  async listInvitations(userId: string | null | undefined) {
    const uid = this.requireUser(userId);
    const workspace = await this.workspace(uid);
    // Auto-expire overdue pending invites before returning
    await this.db.query(
      "UPDATE invitations SET status = 'expired', updated_at = now() WHERE organization_id = $1 AND status = 'pending' AND expires_at < now()",
      [workspace.id]
    );
    const res = await this.db.query(
      `SELECT i.id, i.email, i.role, i.status, i.expires_at, i.created_at, i.project_ids,
              u.name AS invited_by_name, u.email AS invited_by_email,
              COALESCE(
                (SELECT json_agg(json_build_object('id', p.id, 'name', p.name))
                 FROM projects p WHERE p.id = ANY(i.project_ids::uuid[])),
                '[]'::json
              ) AS projects
       FROM invitations i
       LEFT JOIN users u ON u.id = i.invited_by
       WHERE i.organization_id = $1 AND i.status IN ('pending', 'expired')
       ORDER BY i.created_at DESC`,
      [workspace.id]
    );
    return res.rows.map((row) => ({
      ...toCamel(row),
      invitedByName: row.invited_by_name,
      invitedByEmail: row.invited_by_email,
      projects: row.projects ?? []
    }));
  }

  async cancelInvitation(userId: string | null | undefined, inviteId: string) {
    const uid = this.requireUser(userId);
    const workspace = await this.workspace(uid);
    const callerRole = this.normalizeRole(workspace.role);
    const invite = await this.db.query<{ id: string; status: string; invited_by: string | null; email: string }>(
      "SELECT id, status, invited_by, email FROM invitations WHERE id = $1 AND organization_id = $2",
      [inviteId, workspace.id]
    );
    if (!invite.rows[0]) throw new NotFoundException({ error: "Invitation not found" });
    if (invite.rows[0].status !== "pending") throw new BadRequestException({ error: "Only pending invitations can be cancelled" });
    if (callerRole !== "owner" && invite.rows[0].invited_by !== uid)
      throw new ForbiddenException({ error: "You can only cancel invitations you sent" });
    await this.db.query(
      "UPDATE invitations SET status = 'cancelled', cancelled_at = now(), updated_at = now() WHERE id = $1",
      [inviteId]
    );
    await this.logWorkspaceActivity(workspace.id, uid, "invitation_cancelled", "invitation", inviteId, invite.rows[0].email, {});
  }

  async resendInvitation(userId: string | null | undefined, inviteId: string) {
    const uid = this.requireUser(userId);
    const workspace = await this.workspace(uid);
    const callerRole = this.normalizeRole(workspace.role);
    const invite = await this.db.query<{ id: string; email: string; role: string; status: string; invited_by: string | null; project_ids: string[] }>(
      "SELECT id, email, role, status, invited_by, project_ids FROM invitations WHERE id = $1 AND organization_id = $2",
      [inviteId, workspace.id]
    );
    if (!invite.rows[0]) throw new NotFoundException({ error: "Invitation not found" });
    if (invite.rows[0].status !== "pending") throw new BadRequestException({ error: "Only pending invitations can be resent" });
    if (callerRole !== "owner" && invite.rows[0].invited_by !== uid)
      throw new ForbiddenException({ error: "You can only resend invitations you sent" });

    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await this.db.query(
      "UPDATE invitations SET token = $1, expires_at = $2, updated_at = now() WHERE id = $3",
      [tokenHash, expiresAt, inviteId]
    );

    const inviter = await this.db.query<{ name: string | null; email: string }>(
      "SELECT name, email FROM users WHERE id = $1",
      [uid]
    );
    const inviterName = inviter.rows[0]?.name || inviter.rows[0]?.email || "A team member";

    const projectIds: string[] = invite.rows[0]["project_ids"] ?? [];
    let projectNames: string[] = [];
    if (projectIds.length > 0) {
      const projs = await this.db.query<{ name: string }>(
        "SELECT name FROM projects WHERE id = ANY($1::uuid[])",
        [projectIds]
      );
      projectNames = projs.rows.map((r) => r.name);
    }

    await this.email.sendInvite(
      invite.rows[0].email,
      inviterName,
      invite.rows[0].role,
      workspace.name,
      rawToken,
      projectNames,
      this.config.frontendUrl
    );
    await this.logWorkspaceActivity(workspace.id, uid, "invitation_resent", "invitation", inviteId, invite.rows[0].email, {});
    return { resent: true };
  }

  async getInvitationByToken(rawToken: string) {
    const tokenHash = this.hashToken(rawToken);
    const res = await this.db.query(
      `SELECT i.id, i.organization_id, i.email, i.role, i.status, i.expires_at, i.accepted_at, i.created_at, i.project_ids,
              o.name AS organization_name,
              COALESCE(
                (SELECT json_agg(json_build_object('id', p.id, 'name', p.name))
                 FROM projects p WHERE p.id = ANY(i.project_ids::uuid[])),
                '[]'::json
              ) AS projects
       FROM invitations i
       LEFT JOIN organizations o ON o.id = i.organization_id
       WHERE i.token = $1`,
      [tokenHash]
    );
    if (!res.rows[0]) throw new NotFoundException({ error: "Invitation not found or token is invalid" });
    const row = res.rows[0];

    // Auto-expire if past expiry
    if (row.status === "pending" && new Date(row.expires_at) < new Date()) {
      await this.db.query("UPDATE invitations SET status = 'expired', updated_at = now() WHERE id = $1", [row.id]);
      row.status = "expired";
    }

    // Check if email already has an account (so frontend knows which flow to show)
    const hasAccount = await this.db.query<{ id: string }>(
      "SELECT id FROM users WHERE email = $1 AND password_hash IS NOT NULL",
      [row.email]
    );

    return {
      id: row.id,
      organizationId: row.organization_id,
      organizationName: row.organization_name,
      email: row.email,
      role: row.role,
      status: row.status,
      expiresAt: row.expires_at,
      acceptedAt: row.accepted_at,
      createdAt: row.created_at,
      projects: row.projects ?? [],
      hasAccount: !!hasAccount.rows[0]
    };
  }

  async acceptInvitation(userId: string | null | undefined, rawToken: string) {
    const uid = this.requireUser(userId);
    const tokenHash = this.hashToken(rawToken);
    const invite = await this.db.query<{ id: string; organization_id: string; email: string; role: string; status: string; expires_at: string; project_ids: string[] }>(
      "SELECT id, organization_id, email, role, status, expires_at, project_ids FROM invitations WHERE token = $1",
      [tokenHash]
    );
    if (!invite.rows[0]) throw new NotFoundException({ error: "Invitation not found or token is invalid" });
    const inv = invite.rows[0];

    if (inv.status === "cancelled") throw new BadRequestException({ error: "This invitation has been cancelled" });
    if (inv.status === "accepted") throw new BadRequestException({ error: "This invitation has already been accepted" });
    if (inv.status === "expired" || new Date(inv.expires_at) < new Date())
      throw new BadRequestException({ error: "This invitation has expired. Ask the sender to resend it." });

    // Verify the logged-in user's email matches the invited email
    const user = await this.db.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [uid]);
    if (!user.rows[0]) throw new NotFoundException({ error: "User not found" });
    if (user.rows[0].email.toLowerCase() !== inv.email.toLowerCase())
      throw new ForbiddenException({ error: "You must sign in with the invited email address to accept this invite" });

    await this.db.transaction(async (client) => {
      await client.query(
        "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role",
        [inv.organization_id, uid, inv.role]
      );
      if (inv.project_ids?.length > 0) {
        for (const projectId of inv.project_ids) {
          await client.query(
            "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role",
            [projectId, uid, inv.role]
          );
        }
      }
      await client.query(
        "UPDATE invitations SET status = 'accepted', accepted_at = now(), updated_at = now() WHERE id = $1",
        [inv.id]
      );
      await client.query("UPDATE users SET active_organization_id = $1, updated_at = now() WHERE id = $2", [
        inv.organization_id,
        uid
      ]);
    });

    await this.logWorkspaceActivity(inv.organization_id, uid, "invitation_accepted", "invitation", inv.id, inv.email, { role: inv.role });
    for (const projectId of inv.project_ids ?? []) {
      await this.logProjectActivity(projectId, uid, "project_member_added", "project_member", uid, inv.email, { role: inv.role, via: "invitation_accepted" });
    }

    return { accepted: true, organizationId: inv.organization_id };
  }

  async registerFromInvitation(rawToken: string, body: Body) {
    const inv = await this.getInvitationRowOrThrow(rawToken);

    const name = validatePersonName(body.name, "Name");
    const pw = String(body.password || "").trim();
    this.password.assertValidPassword(pw);

    // Ensure the email is not already taken
    const existingUser = await this.db.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [inv.email]);
    if (existingUser.rows[0]) throw new BadRequestException({ error: "An account with this email already exists. Please sign in and accept the invite." });

    const passwordHash = this.password.hashPassword(pw);

    const newUser = await this.db.transaction(async (client) => {
      const uRes = await client.query<{ id: string }>(
        "INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id",
        [inv.email, name, passwordHash]
      );
      const uid = uRes.rows[0].id;
      await client.query(
        "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)",
        [inv.organization_id, uid, inv.role]
      );
      await client.query("UPDATE users SET active_organization_id = $1, updated_at = now() WHERE id = $2", [
        inv.organization_id,
        uid
      ]);
      if (inv.project_ids?.length > 0) {
        for (const projectId of inv.project_ids) {
          await client.query(
            "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
            [projectId, uid, inv.role]
          );
        }
      }
      await client.query(
        "UPDATE invitations SET status = 'accepted', accepted_at = now(), updated_at = now() WHERE id = $1",
        [inv.id]
      );
      return uid;
    });

    await this.logWorkspaceActivity(inv.organization_id, newUser, "invitation_accepted", "invitation", inv.id, inv.email, { role: inv.role, viaRegistration: true });
    for (const projectId of inv.project_ids ?? []) {
      await this.logProjectActivity(projectId, newUser, "project_member_added", "project_member", newUser, inv.email, { role: inv.role, via: "invitation_registered" });
    }

    return { userId: newUser, organizationId: inv.organization_id };
  }

  async changeWorkspaceMemberRole(userId: string | null | undefined, targetUserId: string, newRole: string) {
    const uid = this.requireUser(userId);
    const workspace = await this.workspace(uid);
    const callerRole = this.normalizeRole(workspace.role);
    if (callerRole !== "owner") throw new ForbiddenException({ error: "Only the owner can change roles" });
    if (uid === targetUserId) throw new BadRequestException({ error: "You cannot change your own role" });
    if (!isUuid(targetUserId)) throw new BadRequestException({ error: "userId is not a valid user id" });

    const target = await this.db.query<{ role: string; email: string }>(
      `SELECT om.role, u.email FROM organization_members om JOIN users u ON u.id = om.user_id
       WHERE om.organization_id = $1 AND om.user_id = $2`,
      [workspace.id, targetUserId]
    );
    if (!target.rows[0]) throw new NotFoundException({ error: "Member not found" });
    const targetRole = this.normalizeRole(target.rows[0].role);
    if (targetRole === "owner") throw new ForbiddenException({ error: "Owner role cannot be changed" });

    // Parsed, not normalized: normalizeRole turns an unrecognised role into qa_engineer, so a typo
    // in a promotion request used to demote the member it was meant to promote.
    const normalized = this.parseRole(newRole);
    if (!normalized) throw new BadRequestException({ error: `"${String(newRole)}" is not a role in this workspace` });
    if (normalized === "owner") throw new ForbiddenException({ error: "Cannot promote to owner" });

    await this.db.query(
      "UPDATE organization_members SET role = $1 WHERE organization_id = $2 AND user_id = $3",
      [normalized, workspace.id, targetUserId]
    );
    await this.logWorkspaceActivity(workspace.id, uid, "workspace_member_role_changed", "workspace_member", targetUserId, target.rows[0].email, { from: targetRole, to: normalized });
  }

  async aiKeys(userId: string | null | undefined) {
    const workspace = await this.workspace(userId);
    const keys = await this.db.query(
      `SELECT id, name, provider, default_model, base_url, auth_header_name, auth_scheme,
              is_active AS active, api_key, created_at, updated_at
       FROM workspace_ai_keys WHERE organization_id = $1 ORDER BY created_at DESC`,
      [workspace.id]
    );
    const projects = await this.db.query(
      `SELECT p.id AS project_id, p.key AS project_key, p.name AS project_name, a.workspace_ai_key_id
       FROM projects p
       LEFT JOIN project_ai_key_allocations a ON a.project_id = p.id
       WHERE p.organization_id = $1 AND p.archived_at IS NULL
       ORDER BY p.name`,
      [workspace.id]
    );
    return {
      keys: keys.rows.map((row) => {
        const item = toCamel(row);
        item.maskedKey = maskSecret(String(row.api_key || ""));
        delete item.apiKey;
        return item;
      }),
      projects: projects.rows.map(toCamel)
    };
  }

  async createAiKey(userId: string | null | undefined, body: Body) {
    const workspace = await this.workspace(userId);
    if (this.normalizeRole(workspace.role) !== "owner") throw new ForbiddenException({ error: "Only the workspace owner can manage AI keys" });
    const name = String(body.name || "").trim();
    const apiKey = String(body.apiKey || "").trim();
    const provider = String(body.provider || "openai").trim().toLowerCase();
    const baseUrl = String(body.baseUrl || "").trim() || null;
    // A catalog provider's auth method is defined by its wire, so store null and let
    // providerAuthHeaders apply the convention. Only user-defined gateways need
    // explicit auth_header_name / auth_scheme overrides.
    const definition = providerDefinition(provider);
    const authHeaderName = definition ? null : (String(body.authHeaderName || "").trim() || null);
    const authScheme = definition ? null : (String(body.authScheme || "").trim() || null);
    if (!name) throw new BadRequestException({ error: "name is required" });
    if (!provider) throw new BadRequestException({ error: "provider is required" });
    // Self-hosted runtimes (Ollama, LM Studio, vLLM) commonly run unauthenticated.
    if (!apiKey && !definition?.optionalApiKey) throw new BadRequestException({ error: "apiKey is required" });
    // A base URL is needed whenever it can't be derived: user-defined gateways, and
    // catalog entries that are per-resource rather than a shared host (Azure).
    const needsBaseUrl = definition ? Boolean(definition.requiresBaseUrl) : true;
    if (needsBaseUrl && !baseUrl && !definition?.defaultBaseUrl) {
      throw new BadRequestException({
        error: definition
          ? `baseUrl is required for ${definition.label}`
          : "baseUrl is required for custom providers"
      });
    }
    const res = await this.db.query(
      `INSERT INTO workspace_ai_keys (organization_id, name, provider, api_key, default_model, base_url, auth_header_name, auth_scheme, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (organization_id, name)
       DO UPDATE SET provider = EXCLUDED.provider, api_key = EXCLUDED.api_key, default_model = EXCLUDED.default_model,
                     base_url = EXCLUDED.base_url, auth_header_name = EXCLUDED.auth_header_name, auth_scheme = EXCLUDED.auth_scheme,
                     is_active = true, updated_at = now()
       RETURNING id, name, provider, default_model, base_url, auth_header_name, auth_scheme, is_active AS active, api_key, created_at, updated_at`,
      [workspace.id, name, provider, apiKey, body.defaultModel || null, baseUrl, authHeaderName, authScheme, userId || null]
    );
    const item = toCamel(res.rows[0]);
    item.maskedKey = maskSecret(apiKey);
    delete item.apiKey;
    return item;
  }

  async deleteAiKey(userId: string | null | undefined, keyId: string) {
    const workspace = await this.workspace(userId);
    if (this.normalizeRole(workspace.role) !== "owner") throw new ForbiddenException({ error: "Only the workspace owner can manage AI keys" });
    await this.db.query("DELETE FROM workspace_ai_keys WHERE id = $1 AND organization_id = $2", [keyId, workspace.id]);
    return { ok: true };
  }

  // The provider catalog, for the settings form: base URLs to prefill, which fields are
  // required, and the seed model. Read-only and secret-free, so any member may fetch it.
  listAiProviders() {
    return {
      providers: Object.entries(PROVIDER_CATALOG).map(([id, definition]) => ({
        id,
        label: definition.label,
        wire: definition.wire,
        defaultBaseUrl: definition.defaultBaseUrl,
        requiresBaseUrl: Boolean(definition.requiresBaseUrl),
        optionalApiKey: Boolean(definition.optionalApiKey),
        defaultModel: definition.defaultModel
      }))
    };
  }

  // Live model discovery. Both Anthropic and OpenAI serve GET /v1/models, it costs no
  // tokens, and it returns only what this key can actually reach — so the picker can
  // never offer a retired or unauthorised model the way a hardcoded list could.
  // Always resolves: on any failure it degrades to the curated list rather than
  // blocking the settings form.
  async listProviderModels(userId: string | null | undefined, body: Body) {
    const workspace = await this.workspace(userId);
    if (this.normalizeRole(workspace.role) !== "owner") {
      throw new ForbiddenException({ error: "Only the workspace owner can manage AI keys" });
    }
    const provider = String(body.provider || "").trim().toLowerCase();
    if (!provider) throw new BadRequestException({ error: "provider is required" });

    let apiKey = String(body.apiKey || "").trim();
    let baseUrl = String(body.baseUrl || "").trim() || null;
    let authHeaderName = String(body.authHeaderName || "").trim() || null;
    let authScheme = String(body.authScheme || "").trim() || null;

    // Editing a saved key: the browser only ever holds the masked value, so resolve the
    // real secret from the row instead of making the user retype it to see the list.
    const keyId = String(body.keyId || "").trim();
    if (!apiKey && keyId) {
      const stored = await this.db.query(
        `SELECT api_key, base_url, auth_header_name, auth_scheme FROM workspace_ai_keys
         WHERE id = $1 AND organization_id = $2`,
        [keyId, workspace.id]
      );
      const row = stored.rows[0];
      if (!row) throw new NotFoundException({ error: "AI key not found" });
      apiKey = String(row.api_key || "");
      baseUrl = baseUrl || row.base_url || null;
      authHeaderName = authHeaderName || row.auth_header_name || null;
      authScheme = authScheme || row.auth_scheme || null;
    }

    const fallback = providerFallbackModels(provider).map((id) => ({ id, displayName: id }));
    // Self-hosted runtimes serve /v1/models unauthenticated, so an absent key is not a
    // reason to skip discovery for them — it is for everyone else.
    if (!apiKey && !providerDefinition(provider)?.optionalApiKey) {
      return { models: fallback, source: "fallback", reason: "Add an API key to load the models it can access." };
    }

    try {
      const served = await this.fetchProviderModels(provider, apiKey, baseUrl, authHeaderName, authScheme);
      const models = served.filter((item) => isChatCapableModelId(provider, item.id));
      if (models.length) return { models, source: "live", reason: "" };
      return { models: fallback, source: "fallback", reason: "The provider returned no chat-capable models." };
    } catch (err) {
      // A custom gateway or a platform like Bedrock/Vertex won't serve /v1/models at all.
      // That's expected, not an error worth failing the form over.
      return { models: fallback, source: "fallback", reason: this.extractAiErrorMessage(err) };
    }
  }

  private buildBearerAuthHeaders(apiKey: string, authHeaderName: string | null, authScheme: string | null): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const name = authHeaderName || "Authorization";
    const scheme = authScheme == null ? "Bearer" : String(authScheme).trim();
    headers[name] = scheme ? `${scheme} ${apiKey}` : apiKey;
    return headers;
  }

  private async fetchProviderModels(
    provider: string,
    apiKey: string,
    baseUrl: string | null,
    authHeaderName: string | null,
    authScheme: string | null
  ): Promise<Array<{ id: string; displayName: string }>> {
    const url = normalizeModelsListUrl(provider, baseUrl);
    const headers = this.providerAuthHeaders(provider, apiKey, authHeaderName, authScheme);

    const rows: Body[] = [];
    let cursor = "";
    // Anthropic pages this endpoint with after_id/has_more — not the page/next_page
    // cursor its other endpoints use. Cap the walk so a gateway that always reports
    // has_more can't spin here; other providers return the whole list in one response.
    for (let page = 0; page < 5; page += 1) {
      // Merge into any query the URL already carries — Azure pins ?api-version= there,
      // and blindly appending "?..." would produce a second, malformed query string.
      const [root, existingQuery = ""] = url.split("?");
      const query = new URLSearchParams(existingQuery);
      query.set("limit", "100");
      if (cursor) query.set("after_id", cursor);
      const res = await fetch(`${root}?${query.toString()}`, { method: "GET", headers });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({} as Body)) as Body;
        const raw = String(errBody.error?.message || errBody.error || res.status);
        throw new Error(this.describeProviderError(provider, res.status, raw) || raw);
      }
      const data = await res.json() as Body;
      const batch = normalizeJsonArray(data.data);
      rows.push(...batch);
      if (providerWire(provider) !== "anthropic" || !data.has_more || !batch.length) break;
      cursor = String(batch[batch.length - 1]?.id || "");
      if (!cursor) break;
    }

    // Anthropic dates are ISO strings, OpenAI's are unix seconds — normalise both so the
    // newest generation sorts to the top and users land on it by default.
    const releasedAt = (row: Body): number => {
      const raw = row?.created_at ?? row?.created;
      if (typeof raw === "number") return raw * 1000;
      const parsed = Date.parse(String(raw || ""));
      return Number.isFinite(parsed) ? parsed : 0;
    };

    // Returns everything the key is served, unfiltered — callers narrow it themselves.
    // Membership checks need the complete list: a deliberately configured model that the
    // picker's chat-only filter hides is still perfectly reachable.
    return rows
      .filter((row) => String(row?.id || "").trim())
      .sort((a, b) => releasedAt(b) - releasedAt(a))
      .map((row) => ({
        id: String(row.id).trim(),
        displayName: String(row.display_name || row.id).trim()
      }));
  }

  async allocateAiKey(userId: string | null | undefined, body: Body) {
    const projectId = String(body.projectId || "");
    if (!projectId) throw new BadRequestException({ error: "projectId is required" });
    // A malformed id must read as "no such project in this workspace", not as a failed uuid cast.
    if (!isUuid(projectId)) throw new NotFoundException({ error: "Project not found" });
    const workspace = await this.workspace(userId);
    if (this.normalizeRole(workspace.role) !== "owner") throw new ForbiddenException({ error: "Only the workspace owner can manage AI keys" });
    const project = await this.db.query("SELECT id FROM projects WHERE id = $1 AND organization_id = $2", [projectId, workspace.id]);
    if (!project.rows[0]) throw new NotFoundException({ error: "Project not found" });
    const keyId = body.workspaceAiKeyId || null;
    if (keyId) {
      const key = await this.db.query("SELECT id FROM workspace_ai_keys WHERE id = $1 AND organization_id = $2", [keyId, workspace.id]);
      if (!key.rows[0]) throw new NotFoundException({ error: "AI key not found" });
    }
    await this.db.query(
      `INSERT INTO project_ai_key_allocations (project_id, workspace_ai_key_id, allocated_by)
       VALUES ($1,$2,$3)
       ON CONFLICT (project_id)
       DO UPDATE SET workspace_ai_key_id = EXCLUDED.workspace_ai_key_id, allocated_by = EXCLUDED.allocated_by, updated_at = now()`,
      [projectId, keyId, userId || null]
    );
    return { ok: true };
  }

  async listProjects(userId: string | null | undefined) {
    const uid = this.requireUser(userId);
    const workspace = await this.workspace(uid);
    const res = await this.db.query(
      `SELECT p.id, p.key, p.name, COALESCE(p.description, '') AS description,
              COALESCE(p.project_type, 'tesbox') AS project_type,
              COALESCE(pm.role, 'member') AS role, p.created_at, p.settings
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
       WHERE pm.user_id = $1 AND p.organization_id = $2 AND p.archived_at IS NULL
       ORDER BY p.created_at DESC`,
      [uid, workspace.id]
    );
    return res.rows.map((row) => {
      const camelRow = toCamel(row);
      // Raw settings is an internal implementation detail (also carries testcaseIdPrefix,
      // testRunEnvironments, zyraAgent, …) — only the icon override is a card-list concern, so pull
      // just that out and drop the rest rather than leaking the whole blob to this list endpoint.
      const icon = parseSettings(row.settings).icon as ProjectIcon | undefined;
      camelRow.icon = icon && (icon.color || icon.glyph) ? { color: icon.color ?? null, glyph: icon.glyph ?? null } : null;
      delete camelRow.settings;
      return camelRow;
    });
  }

  /**
   * Every projects-list card's stats, for all the caller's projects, in one response.
   *
   * The screen used to assemble this client-side: `listProjects()` and then, per project, five
   * concurrent calls (test cases, suites, activity, members, runs). At fifteen projects that is
   * seventy-five requests, and the page held its spinner until the slowest of them returned —
   * `setLoading(false)` sat in the `finally` of the outer chain, so one slow call blocked first
   * paint entirely. Against a managed Postgres where a round trip costs far more than the scan,
   * that was also the single largest source of connection demand in the product.
   *
   * Five statements here, each grouped over the whole project set, replace those seventy-five
   * requests — the cost stops scaling with the number of projects. Each one reproduces the
   * semantics of the endpoint it displaces exactly, because the card's numbers have to keep
   * agreeing with the screens those endpoints back:
   *
   *  - test case count excludes deleted AND Archived, matching listTestCases' default filters
   *  - suite count is every suite, nested ones included, matching listSuites' flat list
   *  - the run is the most recently created one with at least one executed case, and the pass rate
   *    divides by executed cases rather than total — the same rule the project dashboard uses
   *  - last activity is the newest row of the same union listActivity reads
   */
  async projectsOverview(userId: string | null | undefined) {
    const uid = this.requireUser(userId);
    const projects = await this.listProjects(uid);
    if (!projects.length) return [];
    const ids = projects.map((p: Record<string, any>) => String(p.id));

    const [cases, suites, members, runs, activity] = await Promise.all([
      // Mirrors listTestCases' default filters: live rows only, and Archived is not part of the
      // working repository (see the comment on listTestCases).
      this.db.query<{ project_id: string; count: number }>(
        `SELECT project_id, COUNT(*)::int AS count
           FROM testcases
          WHERE project_id = ANY($1::uuid[]) AND deleted_at IS NULL AND status IS DISTINCT FROM 'Archived'
          GROUP BY project_id`,
        [ids]
      ),
      this.db.query<{ project_id: string; count: number }>(
        `SELECT project_id, COUNT(*)::int AS count FROM suites WHERE project_id = ANY($1::uuid[]) GROUP BY project_id`,
        [ids]
      ),
      this.db.query<{ project_id: string; user_id: string; name: string }>(
        `SELECT pm.project_id, pm.user_id, COALESCE(NULLIF(u.name, ''), u.email, 'Unknown User') AS name
           FROM project_members pm JOIN users u ON u.id = pm.user_id
          WHERE pm.project_id = ANY($1::uuid[])
          ORDER BY pm.project_id, name`,
        [ids]
      ),
      // DISTINCT ON picks one row per project — the newest run that has actually been executed.
      // Ranking by creation date alone is what let scheduling an empty run replace a finished
      // 100% run with an unstarted one, so the executed filter is part of the definition, not a
      // refinement of it.
      this.db.query<{
        project_id: string;
        total_cases: number;
        passed: number;
        failed: number;
        blocked: number;
        skipped: number;
        untested: number;
      }>(
        `SELECT DISTINCT ON (c.project_id) c.project_id, ${LegacyService.EXECUTION_BUCKET_COUNTS}, c.created_at
           FROM cycles c
           LEFT JOIN cycle_items ci ON ci.cycle_id = c.id
           LEFT JOIN executions e ON e.cycle_item_id = ci.id AND e.deleted_at IS NULL
          WHERE c.project_id = ANY($1::uuid[])
          GROUP BY c.id
         HAVING COUNT(e.id) FILTER (WHERE e.status NOT IN ('Untested', 'Retest')) > 0
          ORDER BY c.project_id, c.created_at DESC`,
        [ids]
      ),
      // The same union listActivity reads, reduced to its newest timestamp per project. The outer
      // query there additionally drops a testcase_* row when a zyra_* sibling exists within five
      // seconds; that sibling is itself in this union, so the presence of activity is identical and
      // only the timestamp can differ, by less than the five seconds that rule spans.
      this.db.query<{ project_id: string; last_activity_at: string }>(
        `SELECT project_id, MAX(created_at) AS last_activity_at FROM (
           SELECT project_id, created_at FROM suites WHERE project_id = ANY($1::uuid[])
           UNION ALL SELECT project_id, updated_at FROM suites
             WHERE project_id = ANY($1::uuid[]) AND updated_at > created_at + interval '1 second'
           UNION ALL SELECT project_id, created_at FROM plans WHERE project_id = ANY($1::uuid[])
           UNION ALL SELECT project_id, updated_at FROM plans
             WHERE project_id = ANY($1::uuid[]) AND updated_at > created_at + interval '1 second'
           UNION ALL SELECT project_id, created_at FROM cycles WHERE project_id = ANY($1::uuid[])
           UNION ALL SELECT project_id, updated_at FROM cycles
             WHERE project_id = ANY($1::uuid[]) AND updated_at > created_at + interval '1 second'
           UNION ALL SELECT project_id, created_at FROM bugs WHERE project_id = ANY($1::uuid[])
           UNION ALL SELECT project_id, updated_at FROM bugs
             WHERE project_id = ANY($1::uuid[]) AND updated_at > created_at + interval '1 second'
           UNION ALL SELECT project_id, created_at FROM audit_logs WHERE project_id = ANY($1::uuid[])
         ) events GROUP BY project_id`,
        [ids]
      )
    ]);

    const caseCounts = new Map(cases.rows.map((r) => [r.project_id, r.count]));
    const suiteCounts = new Map(suites.rows.map((r) => [r.project_id, r.count]));
    const lastActivity = new Map(activity.rows.map((r) => [r.project_id, r.last_activity_at]));
    const runByProject = new Map(runs.rows.map((r) => [r.project_id, r]));
    const membersByProject = new Map<string, { userId: string; name: string }[]>();
    for (const row of members.rows) {
      const list = membersByProject.get(row.project_id) ?? [];
      list.push({ userId: row.user_id, name: row.name });
      membersByProject.set(row.project_id, list);
    }

    return projects.map((project: Record<string, any>) => {
      const id = String(project.id);
      const testCaseCount = caseCounts.get(id) ?? 0;
      const lastActivityAt = lastActivity.get(id) ?? null;
      const run = runByProject.get(id);
      const metrics = run
        ? LegacyService.computeExecutionMetrics({
            passed: run.passed,
            failed: run.failed,
            blocked: run.blocked,
            skipped: run.skipped,
            totalCases: run.total_cases
          })
        : null;
      return {
        ...project,
        testCaseCount,
        suiteCount: suiteCounts.get(id) ?? 0,
        teamMembers: membersByProject.get(id) ?? [],
        lastActivityAt,
        // An empty project needs setting up; one with cases but no activity is configured but idle.
        status: testCaseCount === 0 ? "setup_required" : lastActivityAt ? "active" : "configured",
        runCounts:
          run && metrics && metrics.executed > 0
            ? { passed: run.passed, failed: run.failed, blocked: run.blocked, skipped: run.skipped, total: run.total_cases }
            : null,
        // Passed / (Passed + Failed + Blocked) — see computeExecutionMetrics. A run that is nothing
        // but Skipped cases has no settled verdict, so this is null (rendered as "—"), not 0%.
        currentPassRate: metrics ? metrics.passRate : null
      };
    });
  }

  async createProject(userId: string | null | undefined, body: Body) {
    const uid = this.requireUser(userId);
    const name = String(body.name || "").trim();
    validateProjectFields(name, body.description != null ? String(body.description) : undefined);
    validateProjectKey(body.key != null ? String(body.key) : undefined);
    const icon = validateProjectIcon(body.icon);
    const workspace = await this.workspace(uid);
    // Creating a project is an administrative act, not part of authoring or executing tests. The
    // projects list hides the button from a QA Engineer, but that is presentation — the rule has to
    // hold for anyone posting to this route directly.
    if (this.normalizeRole(workspace.role) === "qa_engineer")
      throw new ForbiddenException({ error: "Only the workspace owner, admin, or manager can create projects" });
    await this.planLimits.assertCanCreateProject(workspace.id);
    const res = await this.insertProjectWithUniqueKey(workspace.id, uid, name, body, icon);
    await this.logProjectActivity(res.id, uid, "project_created", "project", res.id, res.name, {});
    return toCamel(res);
  }

  /**
   * Inserts a project under a key that is unique within the workspace.
   *
   * projectKey() strips a name down to at most 16 alphanumerics, and (organization_id, key) is
   * UNIQUE — so any two names agreeing on that prefix derive the same key. "Mobile App Regression
   * Payments" and "Mobile App Regression Search" are enough, and the second create used to surface
   * the constraint violation as an unhandled 500. The next free numeric suffix is used instead,
   * which keeps the key readable and inside the column's 32 characters.
   *
   * Archived projects keep their keys, so they count as taken here exactly as the unique index sees
   * them. The retry exists because two concurrent creates can both read the same free key: rather
   * than fail the second caller, re-derive and try again.
   */
  private async insertProjectWithUniqueKey(organizationId: string, uid: string, name: string, body: Body, icon?: ProjectIcon) {
    // An explicit key was already validated (validateProjectKey) against the real 32-character
    // column width — sanitize it the same way but do NOT also run it through projectKey()'s
    // 16-character UX slice, or a caller-chosen key gets silently shortened just like the bug
    // this validation exists to catch. Only the name-derived fallback keeps that shorter budget.
    const explicitKey = body.key != null ? sanitizeKey(String(body.key)) : "";
    const requestedBase = explicitKey || projectKey(name);
    // No icon chosen stores an empty settings object, same as before this field existed, so a
    // project created without one still falls back to the deterministic color + initial on read.
    const settingsJson = icon && (icon.color || icon.glyph) ? JSON.stringify({ icon }) : "{}";
    for (let attempt = 1; ; attempt++) {
      const key = await this.nextFreeProjectKey(organizationId, requestedBase);
      try {
        return await this.db.transaction(async (client) => {
          const project = await client.query(
            `INSERT INTO projects (organization_id, key, name, description, project_type, settings)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id, key, name, project_type, created_at`,
            [organizationId, key, name, body.description || "", body.projectType || "tesbox", settingsJson]
          );
          await client.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')", [
            project.rows[0].id,
            uid
          ]);
          await this.seedKnowledgeBaseDefaults(client, organizationId, project.rows[0].id);
          return project.rows[0];
        });
      } catch (error) {
        const isKeyCollision =
          (error as { code?: string })?.code === "23505" &&
          String((error as { constraint?: string })?.constraint || "").includes("key");
        if (!isKeyCollision || attempt >= 3) throw error;
      }
    }
  }

  private async nextFreeProjectKey(organizationId: string, base: string): Promise<string> {
    const res = await this.db.query<{ key: string }>("SELECT key FROM projects WHERE organization_id = $1", [
      organizationId
    ]);
    const taken = new Set(res.rows.map((row) => row.key));
    if (!taken.has(base)) return base;
    for (let n = 2; n <= 999; n++) {
      const suffix = String(n);
      const candidate = `${base.slice(0, PROJECT_KEY_MAX_LENGTH - suffix.length)}${suffix}`;
      if (!taken.has(candidate)) return candidate;
    }
    // A thousand projects sharing one 16-character prefix is not a case worth refusing a create
    // over — fall back to a random tail rather than raising.
    return `${base.slice(0, PROJECT_KEY_MAX_LENGTH - 6)}${randomBytes(3).toString("hex").toUpperCase()}`;
  }

  private async seedKnowledgeBaseDefaults(client: PoolClient, organizationId: string, projectId: string) {
    await client.query(
      `INSERT INTO knowledge_folders (organization_id, project_id, parent_folder_id, name, is_root)
       VALUES ($1, $2, NULL, 'Knowledge base', true)`,
      [organizationId, projectId]
    );
  }

  async getProject(id: string) {
    const res = await this.db.query("SELECT * FROM projects WHERE id = $1 AND archived_at IS NULL", [id]);
    if (!res.rows[0]) throw new NotFoundException({ error: "Project not found" });
    return toCamel(res.rows[0]);
  }

  // Confirms the caller is a member of this project AND that the project belongs to
  // their currently active workspace, so switching workspaces fully isolates data —
  // a project from another org is invisible/inaccessible until you switch into it.
  // Also surfaces the caller's own project role (caller_role) since the join is
  // already scoped to pm.user_id = the caller — callers that need to permission-check
  // an action (e.g. addProjectMember) can reuse this instead of a second query.
  async requireProjectAccess(userId: string | null | undefined, projectId: string) {
    const uid = this.requireUser(userId);
    // A malformed id gets the same answer as a well-formed one that doesn't exist: it isn't a
    // project this caller can reach, and saying so costs nothing. Without this the uuid cast fails
    // in Postgres and every project-scoped endpoint answers a typo with a 500.
    if (!isUuid(projectId)) throw new NotFoundException({ error: "Project not found" });
    const workspace = await this.workspace(uid);
    const res = await this.db.query(
      `SELECT p.*, pm.role AS caller_role FROM projects p
       JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $2
       WHERE p.id = $1 AND p.archived_at IS NULL AND p.organization_id = $3`,
      [projectId, uid, workspace.id]
    );
    if (!res.rows[0]) throw new NotFoundException({ error: "Project not found" });
    return res.rows[0];
  }

  async getProjectForUser(userId: string | null | undefined, id: string) {
    return toCamel(await this.requireProjectAccess(userId, id));
  }

  async updateProject(id: string, body: Body) {
    const name = body.name !== undefined ? String(body.name).trim() : undefined;
    const description = body.description !== undefined ? String(body.description) : undefined;
    validateProjectFields(name, description);
    const icon = validateProjectIcon(body.icon);
    await this.db.query(
      `UPDATE projects SET
       name = COALESCE($2, name),
       description = COALESCE($3, description),
       settings = COALESCE($4::jsonb, settings),
       updated_at = now()
       WHERE id = $1`,
      [id, name ?? null, description ?? null, body.settings ? JSON.stringify(body.settings) : null]
    );
    if (icon !== undefined) {
      // A targeted jsonb_set rather than a read-modify-write of the whole settings blob, so an icon
      // change can't race a concurrent save of testcaseIdPrefix/testRunEnvironments (or vice versa)
      // and silently drop whichever one lost the race.
      await this.db.query(
        `UPDATE projects SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{icon}', $2::jsonb, true), updated_at = now()
         WHERE id = $1`,
        [id, JSON.stringify(icon)]
      );
    }
  }

  // Membership alone is not enough to reconfigure a project. Every neighbouring administrative
  // action — project members, knowledge-base writes, renaming the workspace — is owner-or-manager,
  // and renaming a project is not part of authoring or executing tests.
  async updateProjectForUser(userId: string | null | undefined, id: string, body: Body) {
    const project = await this.requireProjectAccess(userId, id);
    if (this.normalizeRole(project.caller_role) === "qa_engineer")
      throw new ForbiddenException({ error: "QA Engineers cannot change project settings" });
    await this.updateProject(id, body);
  }

  async deleteProject(id: string) {
    await this.db.query("UPDATE projects SET archived_at = now(), updated_at = now() WHERE id = $1", [id]);
  }

  async deleteProjectForUser(userId: string | null | undefined, id: string) {
    const uid = this.requireUser(userId);
    const project = await this.requireProjectAccess(uid, id);
    // The more damaging half of the same gate: archiving takes every child record with it.
    if (this.normalizeRole(project.caller_role) === "qa_engineer")
      throw new ForbiddenException({ error: "QA Engineers cannot archive a project" });
    await this.deleteProject(id);
    await this.logProjectActivity(id, uid, "project_deleted", "project", id, project.name, {});
  }

  // Read-only: any project member (any role) may list the roster.
  async projectMembers(userId: string | null | undefined, projectId: string) {
    await this.requireProjectAccess(userId, projectId);
    const res = await this.db.query(
      `SELECT u.id AS user_id, u.email, COALESCE(u.name, '') AS name, pm.role, pm.created_at AS joined_at
       FROM project_members pm JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = $1 ORDER BY u.email`,
      [projectId]
    );
    return res.rows.map(toCamel);
  }

  async addProjectMember(userId: string | null | undefined, projectId: string, body: Body) {
    const uid = this.requireUser(userId);
    const project = await this.requireProjectAccess(uid, projectId);
    const callerRole = this.normalizeRole(project.caller_role);
    if (callerRole === "qa_engineer") throw new ForbiddenException({ error: "QA Engineers cannot manage project members" });

    const targetUserId = String(body.userId || "");
    if (!targetUserId) throw new BadRequestException({ error: "userId is required" });
    if (!isUuid(targetUserId)) throw new BadRequestException({ error: "userId is not a valid user id" });
    const requestedRole = this.parseRole(body.role === undefined || body.role === null || body.role === "" ? "qa_engineer" : body.role);
    if (!requestedRole) throw new BadRequestException({ error: `"${String(body.role)}" is not a project role` });
    if (requestedRole === "owner") throw new ForbiddenException({ error: "Cannot assign the owner role" });
    if (callerRole === "manager" && requestedRole !== "qa_engineer")
      throw new ForbiddenException({ error: "Managers can only assign the QA Engineer role" });

    // Scoped to the project's workspace on purpose. Resolving the target from `users` alone let any
    // account in the system be dropped into a project by id, which made workspace membership — and
    // with it the whole invitation flow — optional.
    const target = await this.db.query<{ email: string; role: string | null }>(
      `SELECT u.email, pm.role
       FROM users u
       JOIN organization_members om ON om.user_id = u.id AND om.organization_id = $3
       LEFT JOIN project_members pm ON pm.project_id = $1 AND pm.user_id = u.id
       WHERE u.id = $2`,
      [projectId, targetUserId, project.organization_id]
    );
    if (!target.rows[0]) throw new NotFoundException({ error: "That user is not a member of this workspace" });
    const existingRole = target.rows[0].role ? this.normalizeRole(target.rows[0].role) : null;
    if (existingRole === "owner") throw new ForbiddenException({ error: "The project owner's role cannot be changed" });
    if (existingRole && targetUserId === uid) throw new BadRequestException({ error: "You cannot change your own role" });
    if (existingRole && callerRole === "manager" && existingRole === "manager")
      throw new ForbiddenException({ error: "Managers cannot change another manager's role" });

    await this.db.query(
      "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role",
      [projectId, targetUserId, requestedRole]
    );
    await this.logProjectActivity(
      projectId,
      uid,
      existingRole ? "project_member_role_changed" : "project_member_added",
      "project_member",
      targetUserId,
      target.rows[0].email,
      existingRole ? { from: existingRole, to: requestedRole } : { role: requestedRole }
    );
  }

  async removeProjectMember(userId: string | null | undefined, projectId: string, targetUserId: string) {
    const uid = this.requireUser(userId);
    const project = await this.requireProjectAccess(uid, projectId);
    const callerRole = this.normalizeRole(project.caller_role);
    if (callerRole === "qa_engineer") throw new ForbiddenException({ error: "QA Engineers cannot manage project members" });
    if (targetUserId === uid) throw new BadRequestException({ error: "You cannot remove yourself from the project" });
    if (!isUuid(targetUserId)) throw new BadRequestException({ error: "userId is not a valid user id" });

    const target = await this.db.query<{ email: string; role: string }>(
      `SELECT u.email, pm.role FROM project_members pm JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = $1 AND pm.user_id = $2`,
      [projectId, targetUserId]
    );
    if (!target.rows[0]) throw new NotFoundException({ error: "Member not found" });
    const targetRole = this.normalizeRole(target.rows[0].role);
    if (targetRole === "owner") {
      const ownerCount = await this.db.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM project_members WHERE project_id = $1 AND role = 'owner'",
        [projectId]
      );
      if (Number(ownerCount.rows[0].count) <= 1) throw new BadRequestException({ error: "Cannot remove the last project owner" });
    }

    /*
     * "[Test Runs] Unable to assign test cases for execution" edge case: a member removed from the
     * project must not leave executions/bugs still pointing at them as assignee — that assignment
     * would be dangling (visible, but to no one who can act on it). Cleared in the same transaction
     * as the membership delete so a failure partway through never leaves one without the other.
     * Scoped by project_id so removing someone from this project doesn't touch their assignments in
     * a different one.
     */
    await this.db.transaction(async (client) => {
      await client.query("DELETE FROM project_members WHERE project_id = $1 AND user_id = $2", [projectId, targetUserId]);
      await client.query(
        `UPDATE executions e SET assignee_id = NULL, updated_at = now()
           FROM cycle_items ci JOIN cycles c ON c.id = ci.cycle_id
          WHERE e.cycle_item_id = ci.id AND c.project_id = $1 AND e.assignee_id = $2 AND e.deleted_at IS NULL`,
        [projectId, targetUserId]
      );
      await client.query(`UPDATE bugs SET assignee_id = NULL, updated_at = now() WHERE project_id = $1 AND assignee_id = $2`, [
        projectId,
        targetUserId
      ]);
    });
    await this.logProjectActivity(projectId, uid, "project_member_removed", "project_member", targetUserId, target.rows[0].email, { role: targetRole });
  }

  /**
   * Resolves a suite and confirms the caller may reach the project it belongs to.
   *
   * /api/suites/:suiteId is addressed by suite id with no project in the URL, so PATCH and DELETE
   * have to resolve the project themselves. They did not, which meant anyone who could guess a suite
   * id could rename it — or delete it, taking its test cases with it when mode=deleteTestcases.
   */
  private async requireSuiteAccess(userId: string | null | undefined, suiteId: string): Promise<string> {
    const uid = this.requireUser(userId);
    // Same answer for a malformed id as for one that doesn't exist — see requireProjectAccess.
    if (!isUuid(suiteId)) throw new NotFoundException({ error: "Suite not found" });
    const res = await this.db.query<{ project_id: string }>("SELECT project_id FROM suites WHERE id = $1", [suiteId]);
    if (!res.rows[0]) throw new NotFoundException({ error: "Suite not found" });
    await this.requireProjectAccess(uid, res.rows[0].project_id);
    return res.rows[0].project_id;
  }

  async listSuitesForUser(userId: string | null | undefined, projectId: string) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    return this.listSuites(projectId);
  }

  async listSuites(projectId: string) {
    const res = await this.db.query(
      `SELECT s.id, s.parent_id, s.name, s.position, s.created_at, COUNT(t.id)::int AS test_case_count
       FROM suites s LEFT JOIN testcases t ON t.suite_id = s.id AND t.deleted_at IS NULL
       WHERE s.project_id = $1
       GROUP BY s.id ORDER BY s.position, s.name`,
      [projectId]
    );
    return res.rows.map(toCamel);
  }

  async createSuiteForUser(userId: string | null | undefined, projectId: string, body: Body) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    return this.createSuite(projectId, body);
  }

  /**
   * The insert itself, without a caller check.
   *
   * Kept unguarded for the three callers that have already decided access: the MCP tool (whose API
   * token is bound to one project, see McpService), the Zyra chat flow, and CSV import — all of which
   * authorized before they got here. Route traffic goes through createSuiteForUser.
   */
  async createSuite(projectId: string, body: Body) {
    const name = String(body.name || "").trim();
    if (!name) throw new BadRequestException({ error: "name is required" });
    validateBoundedField(name, "Suite name", SUITE_NAME_MAX_LENGTH);
    const res = await this.db.query(
      "INSERT INTO suites (project_id, parent_id, name, position) VALUES ($1, $2, $3, $4) RETURNING id, parent_id, name, position, created_at",
      [projectId, body.parentId || null, name, Number(body.position || 0)]
    );
    return { ...toCamel(res.rows[0]), testCaseCount: 0 };
  }

  async updateSuite(userId: string | null | undefined, suiteId: string, body: Body) {
    await this.requireSuiteAccess(userId, suiteId);
    validateBoundedField(body.name, "Suite name", SUITE_NAME_MAX_LENGTH);
    await this.db.query(
      "UPDATE suites SET name = COALESCE($2, name), parent_id = $3, position = COALESCE($4, position), updated_at = now() WHERE id = $1",
      [suiteId, body.name ?? null, body.parentId ?? null, body.position ?? null]
    );
  }

  async deleteSuite(userId: string | null | undefined, suiteId: string, mode = "moveToDefault") {
    await this.requireSuiteAccess(userId, suiteId);
    if (mode === "deleteTestcases") await this.db.query("DELETE FROM testcases WHERE suite_id = $1", [suiteId]);
    else await this.db.query("UPDATE testcases SET suite_id = NULL WHERE suite_id = $1", [suiteId]);
    await this.db.query("DELETE FROM suites WHERE id = $1", [suiteId]);
  }

  async listTestCasesForUser(userId: string | null | undefined, projectId: string, query: Body) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    return this.listTestCases(projectId, query);
  }

  /**
   * The rows themselves, without a caller check.
   *
   * Kept unguarded for the MCP tool, whose API token is already bound to a single project. Every row
   * carries the project's custom field values, so route traffic goes through listTestCasesForUser.
   */
  /*
   * Ordered by creation, newest first, with id as the final tiebreaker.
   *
   * Basecamp 10212941059 ("Test Case ID Sequence Is Incorrect After Performing Bulk Actions"): this
   * was `ORDER BY updated_at DESC` alone. A bulk update writes `updated_at = now()` to every selected
   * row in ONE statement, so all of them share a single timestamp — and an ORDER BY whose key is not
   * unique leaves the tied rows in whatever order the plan happens to emit. Under LIMIT/OFFSET that
   * is not merely untidy: the two pages of a 33-case project are two separate queries, so a tied row
   * could be returned on both pages while another was never returned at all.
   *
   * external_id is assigned sequentially at creation, so created_at DESC IS the ID sequence the
   * screen displays, and no edit reshuffles it. exportTestCases deliberately keeps its own
   * most-recently-updated order, which api/import-export.spec.ts pins — it gained only the id
   * tiebreaker, so a bulk update can no longer make two exports of the same data disagree.
   */
  async listTestCases(projectId: string, query: Body) {
    const limit = pageNumber(query.limit, 100, 0, 500);
    const offset = pageNumber(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const filters: string[] = ["project_id = $1", "deleted_at IS NULL"];
    const values: any[] = [projectId];
    /*
     * `suiteId=none` asks for the cases that belong to no suite.
     *
     * There was no way to express that: the filter loop below only builds `suite_id = $n`, and a case
     * with a NULL suite_id therefore matched no suite filter at all — so the "No suites" node in the
     * repository's suite tree had nothing to select with. Cases land unfiled routinely (the create
     * form defaults to no suite, an import with no suite column mapped leaves it null, and Zyra's chat
     * only files a case when the model names a suite), which is Basecamp 10212879823 / 10212867874.
     *
     * Handled before the loop because "none" is a truthy value the loop would otherwise push into a
     * `suite_id = 'none'` comparison against a uuid column.
     */
    const suiteFilter = String(query.suiteId ?? "");
    const wantsUnfiled = suiteFilter.toLowerCase() === UNASSIGNED_SUITE_ID;
    if (wantsUnfiled) filters.push("suite_id IS NULL");
    /*
     * Anything else in `suiteId` has to be a uuid before it reaches the column. `suite_id` is uuid,
     * so a malformed value (a stale id pasted from a URL, a truncated copy/paste) came back as
     * Postgres 22P02 `invalid input syntax for type uuid` surfacing as a 500 — an unfiltered list
     * request reading to the caller as a server fault rather than a bad parameter.
     */
    if (suiteFilter && !wantsUnfiled && !isUuid(suiteFilter)) {
      throw new BadRequestException({ error: "suiteId must be a valid id" });
    }
    /*
     * Archived cases are out of the working list unless they are asked for.
     *
     * "Archived" is the status Zyra's archive operation sets when a user asks it to remove test cases,
     * and it is what the UI's archive action sets. They were still listed by default, so a user who
     * had just archived three cases saw them sitting in the repository and concluded nothing had
     * happened — then asked again and got duplicates (Basecamp 10212766570).
     *
     * Two ways to see them, so nothing is unreachable: `status=Archived` explicitly, or
     * `includeArchived=true` to get the whole repository. repositorySummary is untouched and still
     * counts them into its Deprecated bucket, which is what the screen's DEPRECATED tile reads.
     */
    const statusFilter = String(query.status ?? "").trim();
    const includeArchived =
      statusFilter.toLowerCase() === "archived" || String(query.includeArchived ?? "").toLowerCase() === "true";
    if (!includeArchived) filters.push("status IS DISTINCT FROM 'Archived'");
    for (const [param, column] of [
      ["suiteId", "suite_id"],
      ["status", "status"],
      ["priority", "priority"],
      ["type", "type"],
      ["automationStatus", "automation_status"],
      ["jiraIssueKey", "jira_issue_key"],
      ["linearIssueKey", "linear_issue_key"]
    ] as const) {
      if (param === "suiteId" && wantsUnfiled) continue;
      if (query[param]) {
        values.push(query[param]);
        // "type" can enter the system with inconsistent casing (e.g. an imported testcase
        // whose source file used "REGRESSION" instead of the app's canonical "Regression") —
        // match case-insensitively so filtering by type still finds it instead of silently
        // returning zero rows.
        filters.push(param === "type" ? `lower(${column}) = lower($${values.length})` : `${column} = $${values.length}`);
      }
    }
    if (query.search) {
      values.push(`%${String(query.search).toLowerCase()}%`);
      const p = values.length;
      filters.push(
        `(lower(title) LIKE $${p} OR lower(coalesce(description, '')) LIKE $${p} OR lower(coalesce(external_id, '')) LIKE $${p} OR lower(coalesce(type, '')) LIKE $${p})`
      );
    }

    // Custom field filters join custom_field_values once per condition (each scoped 1:1 by
    // definition_id + testcase_id, so no fan-out risk) — see CustomFieldsService.buildListFilterSql.
    let customFieldJoinSql = "";
    if (query.customFieldFilters) {
      const cf = await this.customFields.buildListFilterSql(projectId, query.customFieldFilters, values.length);
      customFieldJoinSql = cf.joinSql;
      if (cf.whereSql) filters.push(cf.whereSql);
      values.push(...cf.params);
    }

    const where = filters.join(" AND ");
    values.push(limit, offset);
    // Total comes back as a window function on the same statement rather than a second
    // COUNT(*) query. This endpoint backs the repository table, the suite tree and the run
    // picker, and against a managed Postgres the round trip costs far more than the scan does,
    // so folding two trips into one roughly halves its latency. COUNT(*) OVER () is evaluated
    // after WHERE and before LIMIT, so it still reports every matching row.
    const res = await this.db.query(
      `SELECT testcases.id, testcases.external_id, testcases.title, testcases.priority, testcases.type,
              testcases.automation_status, testcases.automation_tags, testcases.status,
              testcases.suite_id, testcases.owner_id, testcases.updated_at, testcases.jira_issue_key,
              testcases.jira_url, testcases.linear_issue_key, testcases.linear_url,
              COALESCE(
                (SELECT jsonb_object_agg(v.definition_id, v.value) FROM custom_field_values v WHERE v.testcase_id = testcases.id),
                '{}'::jsonb
              ) AS custom_field_values,
              COUNT(*) OVER () AS total_count
       FROM testcases ${customFieldJoinSql} WHERE ${where}
       ORDER BY testcases.created_at DESC, testcases.id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    const total = Number(res.rows[0]?.total_count || 0);
    // total_count is transport for the header, not part of a test case.
    return { rows: res.rows.map(({ total_count, ...row }) => toCamel(row)), total };
  }

  async exportTestCases(projectId: string, customFieldDefinitions: CustomFieldDefinitionDto[] = []): Promise<Body[]> {
    const res = await this.db.query(
      `SELECT t.id, t.external_id, t.title, COALESCE(t.description, '') AS description,
              COALESCE(t.preconditions, '') AS preconditions,
              t.steps, COALESCE(t.test_data, '') AS test_data,
              COALESCE(t.priority, '') AS priority, COALESCE(t.severity, '') AS severity,
              COALESCE(t.type, '') AS type, COALESCE(t.status, '') AS status,
              COALESCE(s.name, '') AS suite, COALESCE(t.component, '') AS component
       FROM testcases t
       LEFT JOIN suites s ON s.id = t.suite_id
       WHERE t.project_id = $1 AND t.deleted_at IS NULL
       -- Export keeps its documented "most recently updated first" contract (pinned by
       -- api/import-export.spec.ts "orders rows by most recently updated"); only the repository LIST
       -- moved to ID sequence, which is what card 10212941059 asked for. The id tiebreaker is the part
       -- that mattered here: a bulk update ties every touched row on one updated_at, and without it the
       -- export's row order was arbitrary between two exports of the same data.
       ORDER BY t.updated_at DESC, t.id DESC`,
      [projectId]
    );

    const valuesByTestcase = new Map<string, Map<string, unknown>>();
    if (customFieldDefinitions.length) {
      const valuesRes = await this.db.query<{ testcase_id: string; definition_id: string; value: unknown }>(
        `SELECT cfv.testcase_id, cfv.definition_id, cfv.value
         FROM custom_field_values cfv
         JOIN testcases t ON t.id = cfv.testcase_id
         WHERE t.project_id = $1`,
        [projectId]
      );
      for (const row of valuesRes.rows) {
        if (!valuesByTestcase.has(row.testcase_id)) valuesByTestcase.set(row.testcase_id, new Map());
        valuesByTestcase.get(row.testcase_id)!.set(row.definition_id, row.value);
      }
    }

    return res.rows.map((row) => {
      const steps = normalizeJsonArray(row.steps)
        .map((step) => {
          if (typeof step === "string") return step;
          return [step.action || step.step || step.description, step.expectedResult || step.expected]
            .filter(Boolean)
            .join(" => ");
        })
        .filter(Boolean)
        .join(" | ");
      const exportRow: Body = {
        externalId: row.external_id || "",
        title: row.title || "",
        description: row.description || "",
        preconditions: row.preconditions || "",
        steps,
        testData: row.test_data || "",
        priority: row.priority || "",
        severity: row.severity || "",
        type: row.type || "",
        status: row.status || "",
        suite: row.suite || "",
        component: row.component || ""
      };
      for (const definition of customFieldDefinitions) {
        const raw = valuesByTestcase.get(row.id)?.get(definition.id);
        exportRow[`cf_${definition.key}`] = formatCustomFieldExportValue(definition, raw);
      }
      return exportRow;
    });
  }

  /**
   * One test case, scoped to a project the caller can reach.
   *
   * The project id is not redundant with the test case id: it is what makes this answerable without
   * a second round trip, and it means a case belonging to another project is "not found" here rather
   * than readable by whoever guesses its uuid.
   */
  async getTestCaseForUser(userId: string | null | undefined, projectId: string, testcaseId: string) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    if (!isUuid(testcaseId)) throw new NotFoundException({ error: "Test case not found" });
    const res = await this.db.query("SELECT * FROM testcases WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL", [
      testcaseId,
      projectId
    ]);
    if (!res.rows[0]) throw new NotFoundException({ error: "Test case not found" });
    return toCamel(res.rows[0]);
  }

  /**
   * One test case by id alone, without a caller check.
   *
   * Kept unguarded for the Zyra chat flow, which re-reads a row it has just written through an
   * already-authorized path. Route traffic goes through getTestCaseForUser.
   */
  async getTestCase(id: string) {
    const res = await this.db.query("SELECT * FROM testcases WHERE id = $1 AND deleted_at IS NULL", [id]);
    if (!res.rows[0]) throw new NotFoundException({ error: "Test case not found" });
    return toCamel(res.rows[0]);
  }

  /**
   * Confirms the caller may reach this project AND that the case actually belongs to it.
   *
   * Both halves matter. requireUser alone — which is all these handlers used to do — lets any signed-in
   * user edit or delete another tenant's case by uuid. Authorizing only the project in the URL is not
   * enough either: the case id is separate input, so a caller could pass their own project alongside
   * someone else's case id and have the check pass.
   */
  private async requireTestCaseAccess(userId: string | null | undefined, projectId: string, testcaseId: string) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    if (!isUuid(testcaseId)) throw new NotFoundException({ error: "Test case not found" });
    const res = await this.db.query("SELECT id FROM testcases WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL", [
      testcaseId,
      projectId
    ]);
    if (!res.rows[0]) throw new NotFoundException({ error: "Test case not found" });
  }

  async createTestCaseForUser(userId: string | null | undefined, projectId: string, body: Body) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    return this.createTestCase(projectId, userId, body);
  }

  async updateTestCaseForUser(userId: string | null | undefined, projectId: string, testcaseId: string, body: Body) {
    await this.requireTestCaseAccess(userId, projectId, testcaseId);
    return this.updateTestCase(testcaseId, userId, body);
  }

  async duplicateTestCaseForUser(userId: string | null | undefined, projectId: string, testcaseId: string) {
    await this.requireTestCaseAccess(userId, projectId, testcaseId);
    return this.duplicateTestCase(testcaseId, userId);
  }

  async deleteTestCaseForUser(userId: string | null | undefined, projectId: string, testcaseId: string) {
    await this.requireTestCaseAccess(userId, projectId, testcaseId);
    return this.deleteTestCase(testcaseId, userId);
  }

  /**
   * The insert itself, without a project check.
   *
   * Kept unguarded for the callers that have already decided access: the MCP tool (token bound to one
   * project), the Zyra chat flow, and CSV import. Route traffic goes through createTestCaseForUser.
   */
  /*
   * Every length-bounded column on `testcases`, with the width its migration actually declares.
   *
   * Basecamp 10226376787 came in as "Internal Server Error When Adding a Long Description to Test Case
   * Details". The description is TEXT and cannot overflow — the screenshot shows the long text was in
   * the TITLE, which is VARCHAR(512). Nothing bounded it, so Postgres raised 22001
   * (string_data_right_truncation) and, with no handler for that code, the create answered 500.
   *
   * Title was simply the field the reporter happened to use. All fourteen of these are reachable
   * through the API with no validation between the caller and the column, so each one was its own
   * latent 500 — the same defect class as the Knowledge Base folder rename (Basecamp 10199204536).
   *
   * Kept as data next to the widths rather than as scattered `if` blocks so a future ALTER that widens
   * or adds a column has exactly one place to stay in step with.
   */
  private static readonly TESTCASE_FIELD_LIMITS: ReadonlyArray<{ field: string; label: string; max: number }> = [
    { field: "automationRepo", label: "Automation repo", max: 1024 },
    { field: "title", label: "Title", max: 512 },
    { field: "automationPath", label: "Automation path", max: 512 },
    { field: "automationTestName", label: "Automation test name", max: 512 },
    { field: "automationTags", label: "Automation tags", max: 512 },
    { field: "component", label: "Component", max: 255 },
    { field: "automationFramework", label: "Automation framework", max: 64 },
    { field: "estimatedDuration", label: "Estimated duration", max: 64 },
    { field: "severity", label: "Severity", max: 32 },
    { field: "type", label: "Type", max: 32 },
    { field: "status", label: "Status", max: 32 },
    { field: "automationStatus", label: "Automation type", max: 32 },
    { field: "externalId", label: "Test case ID", max: 32 },
    { field: "priority", label: "Priority", max: 8 }
  ];

  /*
   * Estimated duration: plain minutes ("90") or an hours/minutes form ("2h", "45m", "2h 30m").
   *
   * Basecamp 10226363759 reported that this field "accepts invalid text and special characters". It was
   * worse than that: the frontend has always sent `estimatedDuration` on create and update, and the
   * backend had NO reference to it anywhere, so the V7 `estimated_duration VARCHAR(64)` column was dead
   * and every value typed was silently discarded. It accepted anything because it stored nothing.
   *
   * Now persisted and bounded to a shape a report could add up. An empty value is allowed and clears
   * the field, because "no estimate yet" is a legitimate answer.
   */
  private static readonly DURATION_MINUTES = "m|min|mins|minute|minutes";
  private static readonly DURATION_HOURS = "h|hr|hrs|hour|hours";
  /*
   * Deliberately accepts the spellings the form itself suggests. The input's placeholder is "e.g. 10 min",
   * so a pattern that took only "10m" would have made the product's own guidance invalid — the field
   * would reject exactly what it told the user to type.
   */
  private static readonly ESTIMATED_DURATION_RE = new RegExp(
    `^(?:\\d{1,4}` +
      `|\\d{1,4}\\s*(?:${LegacyService.DURATION_HOURS})(?:\\s*\\d{1,2}\\s*(?:${LegacyService.DURATION_MINUTES}))?` +
      `|\\d{1,4}\\s*(?:${LegacyService.DURATION_MINUTES}))$`,
    "i"
  );

  private normalizeEstimatedDuration(raw: unknown): string | null {
    if (raw === undefined || raw === null) return null;
    const value = String(raw).trim();
    if (!value) return "";
    if (!LegacyService.ESTIMATED_DURATION_RE.test(value)) {
      throw new BadRequestException({
        error: 'Estimated duration must be minutes ("90") or hours and minutes ("2h", "2h 30m")'
      });
    }
    return value;
  }

  /**
   * Refuses an over-long value before it can reach a bounded column.
   *
   * Only fields actually present in the body are checked, so a PATCH that omits a field is untouched.
   * The message names the field and the limit — a bare "Internal server error" told the reporter
   * nothing about which of fourteen inputs to shorten.
   */
  private assertTestcaseFieldLengths(body: Body): void {
    for (const { field, label, max } of LegacyService.TESTCASE_FIELD_LIMITS) {
      const raw = body[field];
      if (raw === undefined || raw === null) continue;
      const value = String(raw);
      if (value.length > max) {
        throw new BadRequestException({ error: `${label} must be at most ${max} characters` });
      }
    }
  }

  /**
   * Converts a truncation error into a field-level 400 instead of a 500.
   *
   * A backstop, not the primary guard: assertTestcaseFieldLengths above is what callers should hit.
   * This exists because the same tables are written by import, Zyra and the MCP tool, and any path
   * that grows a new column tomorrow would otherwise reintroduce the 500 this card was raised for.
   */
  private rethrowTruncationAs400(error: unknown): never {
    if ((error as { code?: string })?.code === "22001") {
      throw new BadRequestException({
        error: "One of the fields is too long for the field it is stored in. Shorten it and try again."
      });
    }
    throw error as Error;
  }

  async createTestCase(projectId: string, actorId: string | null | undefined, body: Body) {
    const uid = this.requireUser(actorId);
    this.assertTestcaseFieldLengths(body);
    // nextExternalId reads MAX(trailing number) + 1 in a separate statement from the INSERT below,
    // so two creates racing in the same project both read the same MAX and both try to write
    // "<KEY>-TC-<n>". idx_testcases_project_external then rejects the loser, and the caller got a
    // bare 500 — reachable by two people adding cases at once, a double-clicked Save, or an import
    // running while someone types. Retry on exactly that collision, recomputing the id each time,
    // which is the same shape insertProjectWithUniqueKey already uses for project keys.
    //
    // Only when the id was allocated for the caller: an externalId they supplied themselves that
    // collides is their input to correct, and silently renumbering it would lose what they asked for.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.insertTestCase(projectId, uid, body);
      } catch (error) {
        const collided =
          !body.externalId &&
          (error as { code?: string })?.code === "23505" &&
          String((error as { constraint?: string })?.constraint || "") === "idx_testcases_project_external";
        // A value too long for its column is the caller's to fix, not something to retry.
        if ((error as { code?: string })?.code === "22001") this.rethrowTruncationAs400(error);
        if (!collided || attempt >= 5) throw error;
      }
    }
  }

  // Extracted so a caller that needs several inserts atomic with each other (the Zyra review-batch
  // save, below) can run them all against one shared client/transaction instead of each opening its
  // own — insertTestCase itself just wraps this in a single-statement transaction as before.
  private async insertTestCaseWithClient(client: PoolClient, projectId: string, uid: string, body: Body) {
    // Serialize id allocation per project. Reading MAX(n)+1 and inserting are two statements, so
    // without this every concurrent create in a project reads the same MAX and all but one lose to
    // idx_testcases_project_external. Retrying alone does not converge: the losers re-read the same
    // MAX together and collide again, which is why this lock — not the retry above — is the fix.
    //
    // Transaction-scoped, so it releases on COMMIT or ROLLBACK with no unlock to leak, and keyed on
    // the project so creates in different projects never wait on each other. Skipped entirely when
    // the caller pinned their own externalId, since nothing is being allocated. Re-acquiring this same
    // lock more than once for the same project within one transaction (e.g. several creates in a
    // Zyra batch save) is safe — pg_advisory_xact_lock is re-entrant for the same backend/transaction.
    if (!body.externalId) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`testcase-external-id:${projectId}`]);
    }
    const externalId = body.externalId || (await this.nextExternalId(projectId, body.testcaseIdPrefix, client));
    const res = await client.query(
      `INSERT INTO testcases
       (project_id, suite_id, external_id, title, description, preconditions, postconditions, steps, test_data,
        priority, severity, type, automation_status, automation_repo, automation_path, automation_test_name,
        automation_framework, automation_tags, owner_id, component, status, jira_issue_key, jira_url,
        linear_issue_key, linear_url, attachments, created_by, updated_by, estimated_duration)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$27,$28)
       RETURNING *`,
      [
        projectId,
        body.suiteId || null,
        externalId,
        body.title || "Untitled test case",
        body.description || "",
        body.preconditions || "",
        body.postconditions || "",
        JSON.stringify(body.steps || body.stepsJson || []),
        body.testData || "",
        body.priority || "P2",
        body.severity || null,
        body.type || "Functional",
        body.automationStatus || "Not Automated",
        body.automationRepo || null,
        body.automationPath || null,
        body.automationTestName || null,
        body.automationFramework || null,
        body.automationTags || null,
        body.ownerId || null,
        body.component || null,
        body.status || "Draft",
        body.jiraIssueKey || null,
        body.jiraUrl || null,
        body.linearIssueKey || null,
        body.linearUrl || null,
        body.attachments || null,
        uid,
        this.normalizeEstimatedDuration(body.estimatedDuration)
      ]
    );
    const row = res.rows[0];
    // "skip-if-disabled": on a Launch-plan project this silently no-ops rather than
    // throwing, so ordinary test case creation is never blocked by billing state.
    await this.customFields.setValuesForTestCase(uid, projectId, row.id, body.customFieldValues || {}, client, "skip-if-disabled");
    return row;
  }

  private async insertTestCase(projectId: string, uid: string, body: Body) {
    const created = await this.db.transaction(async (client) => this.insertTestCaseWithClient(client, projectId, uid, body));
    await this.logProjectActivity(projectId, uid, "testcase_created", "testcase", created.id, `${created.external_id} - ${created.title}`, { after: toCamel(created) });
    return toCamel(created);
  }

  // Import used to create test cases one HTTP request at a time, each costing ~5 DB round
  // trips (prefix lookup, MAX(external_id), insert, custom fields, activity row) — a
  // 500-row sheet meant thousands of sequential round trips, which is why importing crawled.
  // A batch now costs one request and a handful of statements.
  static readonly MAX_BULK_TESTCASES = 500;

  async bulkCreateTestCases(projectId: string, actorId: string | null | undefined, body: Body) {
    const uid = this.requireUser(actorId);
    const incoming: Body[] = Array.isArray(body.testcases)
      ? body.testcases.filter((row: unknown): row is Body => !!row && typeof row === "object")
      : [];
    if (!incoming.length) return { created: [], createdCount: 0 };
    if (incoming.length > LegacyService.MAX_BULK_TESTCASES) {
      throw new BadRequestException({
        error: `A batch is limited to ${LegacyService.MAX_BULK_TESTCASES} test cases — send larger imports as several batches.`
      });
    }

    /*
     * Every row is bounded before the batch runs, and the row number is named.
     *
     * The INSERT ... SELECT below casts each text column to its varchar width, so one over-long value
     * anywhere in the batch raises 22001 and — as the comment on that statement already noted — fails
     * exactly like the single insert did, i.e. as a 500. Worse here: the whole transaction rolls back,
     * so an import of 500 rows dies on row 400 with nothing written and no indication which row or
     * which field was at fault. Checked up front, and the message names both.
     */
    for (const [index, row] of incoming.entries()) {
      try {
        this.assertTestcaseFieldLengths(row);
      } catch (error) {
        const detail = (error as { response?: { error?: string } })?.response?.error ?? "a field is too long";
        throw new BadRequestException({ error: `Row ${index + 1}: ${detail}` });
      }
    }

    const created = await this.db.transaction(async (client) => {
      // Serialize external-id allocation per project: MAX()+1 alone lets two concurrent
      // imports claim the same block and lose one to the (project_id, external_id) unique
      // index. Advisory lock is transaction-scoped, so it releases on commit or rollback.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`testcase-external-id:${projectId}`]);
      const key = await this.externalIdPrefix(projectId, body.testcaseIdPrefix, client);
      const startSeq = await this.maxExternalIdSeq(projectId, key, client);

      // external_id is derived from the row's index, so it also keys created rows back to
      // their source row below — RETURNING order is not guaranteed to match the input.
      const externalIdFor = (index: number) => `${key}-TC-${startSeq + index + 1}`;
      const payload = incoming.map((row, index) => ({
        ord: index,
        suite_id: row.suiteId || null,
        external_id: row.externalId || externalIdFor(index),
        title: row.title || "Untitled test case",
        description: row.description || "",
        preconditions: row.preconditions || "",
        postconditions: row.postconditions || "",
        steps: row.steps || row.stepsJson || [],
        test_data: row.testData || "",
        priority: row.priority || "P2",
        severity: row.severity || null,
        type: row.type || "Functional",
        automation_status: row.automationStatus || "Not Automated",
        automation_repo: row.automationRepo || null,
        automation_path: row.automationPath || null,
        automation_test_name: row.automationTestName || null,
        automation_framework: row.automationFramework || null,
        automation_tags: row.automationTags || null,
        owner_id: row.ownerId || null,
        component: row.component || null,
        status: row.status || "Draft",
        jira_issue_key: row.jiraIssueKey || null,
        jira_url: row.jiraUrl || null,
        linear_issue_key: row.linearIssueKey || null,
        linear_url: row.linearUrl || null,
        attachments: row.attachments || null
      }));

      // Whole batch as one jsonb parameter rather than 26 placeholders per row, which would
      // otherwise approach Postgres' parameter ceiling on a full batch. The BEFORE INSERT
      // trigger still fills search_vector per row, and text columns take the assignment cast
      // to their varchar widths (over-long values raise the same error as the single insert).
      const res = await client.query(
        `INSERT INTO testcases
           (project_id, suite_id, external_id, title, description, preconditions, postconditions, steps, test_data,
            priority, severity, type, automation_status, automation_repo, automation_path, automation_test_name,
            automation_framework, automation_tags, owner_id, component, status, jira_issue_key, jira_url,
            linear_issue_key, linear_url, attachments, created_by, updated_by)
         SELECT $1::uuid, r.suite_id, r.external_id, r.title, r.description, r.preconditions, r.postconditions,
                r.steps, r.test_data, r.priority, r.severity, r.type, r.automation_status, r.automation_repo,
                r.automation_path, r.automation_test_name, r.automation_framework, r.automation_tags, r.owner_id,
                r.component, r.status, r.jira_issue_key, r.jira_url, r.linear_issue_key, r.linear_url,
                r.attachments, $2::uuid, $2::uuid
         FROM jsonb_to_recordset($3::jsonb) AS r(
           ord int, suite_id uuid, external_id text, title text, description text, preconditions text,
           postconditions text, steps jsonb, test_data text, priority text, severity text, type text,
           automation_status text, automation_repo text, automation_path text, automation_test_name text,
           automation_framework text, automation_tags text, owner_id uuid, component text, status text,
           jira_issue_key text, jira_url text, linear_issue_key text, linear_url text, attachments text
         )
         ORDER BY r.ord
         RETURNING *`,
        [projectId, uid, JSON.stringify(payload)]
      );

      // Only rows that actually carry custom field values pay for a round trip here, so a
      // plain import (the common case) stays at the statement count above.
      const idByExternalId = new Map<string, string>(res.rows.map((row) => [row.external_id, row.id]));
      for (const [index, row] of incoming.entries()) {
        const values = row.customFieldValues;
        if (!values || typeof values !== "object" || !Object.keys(values).length) continue;
        const testcaseId = idByExternalId.get(payload[index].external_id);
        if (!testcaseId) continue;
        await this.customFields.setValuesForTestCase(uid, projectId, testcaseId, values, client, "skip-if-disabled");
      }
      return res.rows;
    });

    // One activity row for the batch, matching how bulk delete records itself — an entry per
    // imported case would bury the rest of the project's history.
    await this.logProjectActivity(projectId, uid, "testcase_bulk_created", "testcase", null, null, {
      testcaseIds: created.map((row) => row.id),
      count: created.length
    });
    return { created: created.map(toCamel), createdCount: created.length };
  }

  /**
   * Imports a whole file's worth of test cases in a fixed handful of database round trips.
   *
   * Each row used to be its own POST /testcases from the browser, and each of those ran a dozen
   * statements of its own — the access check, the id allocation, the insert, the custom field writes,
   * an activity log entry. On this deployment that is essentially the entire cost of the feature: the
   * database is remote and answers a statement in roughly 290ms, against the ~3ms it spends actually
   * running one, so a 500-row file spent something close to half an hour waiting on the network to
   * repeat work that never varied per row.
   *
   * So nothing here is per row. Everything checkable without the database is checked in memory first,
   * and what survives is written with a set-based statement per kind of thing: the suites, the test
   * cases, their custom field values and the activity log entries each go in as one
   * jsonb_to_recordset insert no matter how many rows the chunk holds.
   *
   * Row-level reporting is unchanged — a row that cannot be imported is named in `errors` and every
   * other row still lands. Validation catches that up front. In the rare case where the batch insert
   * itself is rejected, the chunk is rolled back and replayed a row at a time, so the responsible row
   * is named instead of taking its thousand neighbours down with it.
   */
  async importTestCases(userId: string | null | undefined, projectId: string, body: Body) {
    // Refuses outright rather than tying up a connection on a file nobody meant to send.
    const MAX_ROWS = 20000;
    // Rows per transaction. The statement count per chunk is fixed, so this no longer buys much time;
    // it bounds how long the per-project id lock is held against other people adding test cases, and
    // how large a single jsonb payload gets.
    const CHUNK_SIZE = 1000;

    const uid = this.requireUser(userId);
    const project = await this.requireProjectAccess(uid, projectId);

    const rows: Body[] = Array.isArray(body?.rows) ? body.rows : [];
    if (!rows.length) throw new BadRequestException({ error: "rows must be a non-empty array" });
    if (rows.length > MAX_ROWS) {
      throw new BadRequestException({ error: `An import is limited to ${MAX_ROWS} rows per request.` });
    }

    // The suite the user had open when they hit Import. Rows that leave the suite column blank are
    // parented directly to it; rows that name a suite of their own get that suite created/resolved
    // as a CHILD of this one instead of at the project root, so importing from inside a suite always
    // lands the file's structure under it rather than scattering new root-level suites. It arrives as
    // client input like everything else, so it is confirmed to be a suite in THIS project before any
    // row is parented to it.
    let defaultSuiteId: string | null = null;
    if (body?.defaultSuiteId) {
      const candidate = String(body.defaultSuiteId);
      const owned = isUuid(candidate)
        ? await this.db.query("SELECT 1 FROM suites WHERE id = $1 AND project_id = $2", [candidate, projectId])
        : { rows: [] };
      if (!owned.rows[0]) throw new BadRequestException({ error: "defaultSuiteId is not a suite in this project" });
      defaultSuiteId = candidate;
    }

    // One query in place of the client's paginated walk of the entire project, 500 rows per HTTP
    // request. Titles come back raw and are normalized here rather than in SQL because Postgres's \s
    // class and JavaScript's do not cover the same code points, and this set has to agree exactly
    // with the browser's own duplicate preview.
    const existingTitles = await this.db.query<{ title: string }>(
      "SELECT title FROM testcases WHERE project_id = $1 AND deleted_at IS NULL",
      [projectId]
    );
    const titlesInProject = new Set(existingTitles.rows.map((row) => normalizeImportName(row.title)));
    const titlesInFile = new Set<string>();

    const suiteRows = await this.db.query<{ id: string; parent_id: string | null; name: string }>(
      "SELECT id, parent_id, name FROM suites WHERE project_id = $1",
      [projectId]
    );
    const suiteIdByKey = new Map(suiteRows.rows.map((row) => [importSuiteKey(row.name, row.parent_id), row.id]));

    // Null when the workspace's plan has custom fields switched off, which is the same "silently skip
    // rather than block the import" answer createTestCase gives through its "skip-if-disabled" mode.
    const customFieldContext = await this.customFields.loadWriteContext(projectId);

    const settings = parseSettings(project.settings);
    const idPrefix =
      normalizeTestcaseIdPrefix(body?.testcaseIdPrefix) ||
      normalizeTestcaseIdPrefix(settings.testcaseIdPrefix) ||
      normalizeTestcaseIdPrefix(project.key) ||
      "TC";

    const errors: { row: number; message: string }[] = [];
    const expandSuiteIds = new Set<string>();
    let imported = 0;

    const ctx: ImportContext = {
      projectId,
      uid,
      organizationId: project.organization_id,
      idPrefix,
      defaultSuiteId,
      suiteIdByKey,
      expandSuiteIds,
      customFieldContext
    };

    for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
      const chunk = rows.slice(start, start + CHUNK_SIZE);

      // Validated before a connection is even opened. None of it needs the database, and a chunk that
      // turns out to be entirely invalid then costs no round trips at all.
      const prepared: PreparedImportRow[] = [];
      for (const [index, raw] of chunk.entries()) {
        const outcome = this.prepareImportRow(raw, start + index, titlesInProject, titlesInFile, customFieldContext);
        if (outcome.error) errors.push({ row: outcome.rowNumber, message: outcome.error });
        else if (outcome.prepared) prepared.push(outcome.prepared);
      }
      if (!prepared.length) continue;

      await this.db.transaction(async (client) => {
        // The same lock createTestCase takes, held once for the chunk instead of once per row. It is
        // what actually serialises id allocation for a project.
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`testcase-external-id:${projectId}`]);
        // Re-read per chunk, not once for the import: the lock only lives as long as this
        // transaction, so another writer can allocate ids between chunks.
        const maxRes = await client.query<{ n: string }>(
          "SELECT COALESCE(MAX((regexp_match(external_id, '\\d+$'))[1]::int), 0) AS n FROM testcases WHERE project_id = $1 AND external_id LIKE $2",
          [projectId, `${idPrefix}-TC-%`]
        );
        const startNumber = Number(maxRes.rows[0]?.n || 0) + 1;

        // Both caches are written to while the chunk is being inserted, so they are snapshotted to be
        // put back if it rolls back — otherwise the replay below would resolve suite names to ids
        // that the rollback has just taken away.
        const suiteSnapshot = new Map(ctx.suiteIdByKey);
        const expandSnapshot = new Set(ctx.expandSuiteIds);

        await client.query("SAVEPOINT import_chunk");
        try {
          await this.resolveImportSuites(client, ctx, prepared);
          const created = await this.insertImportChunk(client, ctx, prepared, startNumber);
          await client.query("RELEASE SAVEPOINT import_chunk");
          imported += created;
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT import_chunk");
          await client.query("RELEASE SAVEPOINT import_chunk");
          ctx.suiteIdByKey.clear();
          for (const [key, id] of suiteSnapshot) ctx.suiteIdByKey.set(key, id);
          ctx.expandSuiteIds.clear();
          for (const id of expandSnapshot) ctx.expandSuiteIds.add(id);

          // A batch insert is all or nothing, so anything that got past validation would otherwise
          // cost the whole chunk. Replaying a row at a time is slow, but it only happens when
          // something genuinely unexpected is in the file, and it is the only way to name the row
          // responsible rather than failing its thousand neighbours alongside it.
          this.logger.warn(
            `Import batch of ${prepared.length} rows failed for project ${projectId}, replaying row by row: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          const replay = await this.insertImportRowsIndividually(client, ctx, prepared, startNumber);
          imported += replay.imported;
          errors.push(...replay.errors);
        }
      });
    }

    errors.sort((a, b) => a.row - b.row);
    return { imported, total: rows.length, errors, expandSuiteIds: Array.from(expandSuiteIds) };
  }

  /**
   * Everything about one spreadsheet row that can be decided without asking the database.
   *
   * Pulled ahead of the inserts on purpose. The batch insert below is all or nothing, so a cell that
   * Postgres would reject has to be caught here — otherwise it is raised against the whole chunk and
   * every other row in it pays for the replay needed to work out which cell was at fault.
   */
  private prepareImportRow(
    raw: Body,
    fallbackIndex: number,
    titlesInProject: Set<string>,
    titlesInFile: Set<string>,
    customFieldContext: CustomFieldWriteContext | null
  ): { rowNumber: number; error?: string; prepared?: PreparedImportRow } {
    const reported = Number(raw?.rowNumber);
    const rowNumber = Number.isFinite(reported) ? reported : fallbackIndex + 1;

    const title = String(raw?.title ?? "").trim();
    if (!title) return { rowNumber, error: "Title is required" };

    const priority = String(raw?.priority ?? "").trim() || "P2";
    const severity = String(raw?.severity ?? "").trim() || null;
    const type = String(raw?.type ?? "").trim() || "Functional";
    const status = String(raw?.status ?? "").trim() || "Draft";
    const component = String(raw?.component ?? "").trim() || null;
    const suiteName = String(raw?.suite ?? "").trim();

    // Reuses the same shape check createTestCase/updateTestCase already enforce, so an import can't
    // silently accept a duration the rest of the product would reject. Caught here rather than left
    // to throw: every other rejection in this function returns a per-row error so one bad cell costs
    // only its own row, not the whole file.
    let estimatedDuration: string | null;
    try {
      estimatedDuration = this.normalizeEstimatedDuration(raw?.estimatedDuration);
    } catch (error) {
      const message =
        error instanceof BadRequestException
          ? String((error.getResponse() as { error?: string })?.error ?? "Invalid estimated duration")
          : "Invalid estimated duration";
      return { rowNumber, error: message };
    }

    // Mirrors the column widths in the testcases and suites tables. A message naming the field beats
    // a driver error naming a constraint.
    const limits: [string, string | null, number][] = [
      ["Title", title, 512],
      ["Priority", priority, 8],
      ["Severity", severity, 32],
      ["Type", type, 32],
      ["Status", status, 32],
      ["Component", component, 255],
      ["Suite", suiteName, 255]
    ];
    for (const [label, value, limit] of limits) {
      if (value && value.length > limit) {
        return { rowNumber, error: `${label} is longer than the ${limit} character limit` };
      }
    }

    const normalizedTitle = normalizeImportName(title);
    if (titlesInProject.has(normalizedTitle)) {
      return { rowNumber, error: "Skipped duplicate title: already exists in this project" };
    }
    if (titlesInFile.has(normalizedTitle)) {
      return { rowNumber, error: "Skipped duplicate title: repeated in this import file" };
    }
    // Claimed before the row is known to be importable, matching the browser's original order: a
    // title that fails for some other reason still counts as spoken for, so a later identical row
    // reads as a duplicate within the file rather than being attempted a second time.
    titlesInFile.add(normalizedTitle);

    let customFieldValues: Body = {};
    if (customFieldContext) {
      const { normalized, errors } = this.customFields.normalizeValues(raw?.customFieldValues || {}, customFieldContext);
      if (errors.length) return { rowNumber, error: errors.map((entry) => entry.message).join("; ") };
      customFieldValues = normalized;
    }

    return {
      rowNumber,
      prepared: {
        rowNumber,
        title,
        description: String(raw?.description ?? ""),
        preconditions: String(raw?.preconditions ?? ""),
        postconditions: String(raw?.postconditions ?? ""),
        steps: Array.isArray(raw?.steps) ? raw.steps : [],
        testData: String(raw?.testData ?? ""),
        priority,
        severity,
        type,
        status,
        component,
        estimatedDuration,
        suiteName,
        componentName: component ?? "",
        customFieldValues,
        parentSuiteId: null,
        suiteId: null
      }
    };
  }

  /**
   * Creates every suite the chunk names but does not have yet, in at most two statements, and settles
   * which suite each row belongs in.
   *
   * Import files name suites by name rather than id, and the browser used to create them one POST at
   * a time as it walked the rows. The whole chunk's names are known up front, so the missing ones go
   * in one insert per level — the top-level suites first, since the components need their parents to
   * exist before they can point at them.
   *
   * "Top-level" here means "child of the suite the user had open" (ctx.defaultSuiteId), not
   * necessarily the project root: a row's own Suite column nests under wherever Import was launched
   * from, exactly like a Component column nests under its row's resolved suite. When no suite was
   * open (ctx.defaultSuiteId is null — the "All test cases" / project-root view), that parent is null
   * and suite-named rows land at the root, same as before this nested behaviour existed.
   *
   * ctx.suiteIdByKey starts as a snapshot taken once at the top of importTestCases, before any lock
   * is held — a second import into the same project, running concurrently and naming the same new
   * suite, would see the same gap and (without the rescans below) both insert it, leaving two
   * same-named siblings. By the time this method runs, the caller already holds
   * pg_advisory_xact_lock(hashtext(`testcase-external-id:<projectId>`)) for the rest of this
   * transaction, so any concurrent import for this project is either done and committed or still
   * queued behind that same lock — never interleaved with what follows. Re-querying just the
   * candidate parent(s) here, rather than trusting the stale snapshot, is what actually closes the
   * race: a sibling a concurrent import just committed is now visible and reused instead of
   * recreated. (This does not cover a plain "New Suite" click racing an import — that path takes no
   * such lock, and already tolerates duplicate sibling names today; unchanged here.)
   */
  private async resolveImportSuites(client: PoolClient, ctx: ImportContext, prepared: PreparedImportRow[]): Promise<void> {
    const missingTop = new Map<string, string>();
    for (const row of prepared) {
      if (!row.suiteName) continue;
      const key = importSuiteKey(row.suiteName, ctx.defaultSuiteId);
      if (!ctx.suiteIdByKey.has(key)) missingTop.set(key, row.suiteName);
    }
    if (missingTop.size) {
      const rescan = await client.query<{ id: string; name: string }>(
        ctx.defaultSuiteId
          ? "SELECT id, name FROM suites WHERE project_id = $1 AND parent_id = $2"
          : "SELECT id, name FROM suites WHERE project_id = $1 AND parent_id IS NULL",
        ctx.defaultSuiteId ? [ctx.projectId, ctx.defaultSuiteId] : [ctx.projectId]
      );
      for (const row of rescan.rows) {
        const key = importSuiteKey(row.name, ctx.defaultSuiteId);
        ctx.suiteIdByKey.set(key, row.id);
        missingTop.delete(key);
      }
    }
    if (missingTop.size) {
      const created = await client.query<{ id: string; name: string }>(
        `INSERT INTO suites (project_id, parent_id, name, position)
         SELECT $1, $3::uuid, v.name, 0 FROM jsonb_to_recordset($2::jsonb) AS v(name text)
         RETURNING id, name`,
        [ctx.projectId, JSON.stringify(Array.from(missingTop.values(), (name) => ({ name }))), ctx.defaultSuiteId]
      );
      for (const row of created.rows) ctx.suiteIdByKey.set(importSuiteKey(row.name, ctx.defaultSuiteId), row.id);
    }

    const missingChild = new Map<string, { parent_id: string; name: string }>();
    for (const row of prepared) {
      row.parentSuiteId = row.suiteName
        ? ctx.suiteIdByKey.get(importSuiteKey(row.suiteName, ctx.defaultSuiteId)) ?? ctx.defaultSuiteId
        : ctx.defaultSuiteId;
      if (!row.componentName || !row.parentSuiteId) continue;
      // A row that names a component but no suite nests under whatever the user had open, and that
      // folder wants expanding afterwards whether or not the component itself turned out to be new.
      if (!row.suiteName) ctx.expandSuiteIds.add(row.parentSuiteId);
      const key = importSuiteKey(row.componentName, row.parentSuiteId);
      if (!ctx.suiteIdByKey.has(key)) missingChild.set(key, { parent_id: row.parentSuiteId, name: row.componentName });
    }
    if (missingChild.size) {
      const parentIds = Array.from(new Set(Array.from(missingChild.values(), (v) => v.parent_id)));
      const rescan = await client.query<{ id: string; parent_id: string; name: string }>(
        "SELECT id, parent_id, name FROM suites WHERE project_id = $1 AND parent_id = ANY($2::uuid[])",
        [ctx.projectId, parentIds]
      );
      for (const row of rescan.rows) {
        const key = importSuiteKey(row.name, row.parent_id);
        ctx.suiteIdByKey.set(key, row.id);
        missingChild.delete(key);
      }
    }
    if (missingChild.size) {
      const created = await client.query<{ id: string; parent_id: string; name: string }>(
        `INSERT INTO suites (project_id, parent_id, name, position)
         SELECT $1, v.parent_id, v.name, 0 FROM jsonb_to_recordset($2::jsonb) AS v(parent_id uuid, name text)
         RETURNING id, parent_id, name`,
        [ctx.projectId, JSON.stringify(Array.from(missingChild.values()))]
      );
      for (const row of created.rows) {
        ctx.suiteIdByKey.set(importSuiteKey(row.name, row.parent_id), row.id);
        ctx.expandSuiteIds.add(row.parent_id);
      }
    }

    for (const row of prepared) {
      row.suiteId =
        row.componentName && row.parentSuiteId
          ? ctx.suiteIdByKey.get(importSuiteKey(row.componentName, row.parentSuiteId)) ?? row.parentSuiteId
          : row.parentSuiteId;
    }
  }

  /**
   * Writes a prepared chunk: the test cases, their custom field values and the activity log, as one
   * statement each. Returns how many test cases landed.
   *
   * Rows are matched back to what came out of the insert by external id rather than by position —
   * RETURNING makes no promise about ordering, and the ids are what the custom field values and audit
   * rows have to hang off.
   */
  private async insertImportChunk(
    client: PoolClient,
    ctx: ImportContext,
    prepared: PreparedImportRow[],
    startNumber: number
  ): Promise<number> {
    const payload = prepared.map((row, index) => ({
      external_id: `${ctx.idPrefix}-TC-${startNumber + index}`,
      suite_id: row.suiteId,
      title: row.title,
      description: row.description,
      preconditions: row.preconditions,
      postconditions: row.postconditions,
      steps: row.steps,
      test_data: row.testData,
      priority: row.priority,
      severity: row.severity,
      type: row.type,
      status: row.status,
      component: row.component,
      estimated_duration: row.estimatedDuration
    }));

    const inserted = await client.query<Body>(
      `INSERT INTO testcases
         (project_id, suite_id, external_id, title, description, preconditions, postconditions, steps,
          test_data, priority, severity, type, status, component, estimated_duration, created_by, updated_by)
       SELECT $1, v.suite_id, v.external_id, v.title, v.description, v.preconditions, v.postconditions,
              v.steps, v.test_data, v.priority, v.severity, v.type, v.status, v.component,
              v.estimated_duration, $2, $2
       FROM jsonb_to_recordset($3::jsonb) AS v(
         external_id text, suite_id uuid, title text, description text, preconditions text,
         postconditions text, steps jsonb, test_data text, priority text, severity text,
         type text, status text, component text, estimated_duration text)
       RETURNING *`,
      [ctx.projectId, ctx.uid, JSON.stringify(payload)]
    );

    const createdByExternalId = new Map(inserted.rows.map((row) => [row.external_id, row]));
    const auditRows: { action: string; entity_id: string; entity_name: string; diff: Body }[] = inserted.rows.map((row) => ({
      action: "testcase_created",
      entity_id: row.id,
      entity_name: `${row.external_id} - ${row.title}`,
      diff: { after: toCamel(row) }
    }));

    const valueRows: { definition_id: string; testcase_id: string; value: unknown }[] = [];
    if (ctx.customFieldContext) {
      for (const [index, row] of prepared.entries()) {
        const created = createdByExternalId.get(payload[index].external_id);
        if (!created) continue;
        for (const { definitionId, value } of this.customFields.writableValuesForNewTestCase(row.customFieldValues)) {
          valueRows.push({ definition_id: definitionId, testcase_id: created.id, value });
          const definition = ctx.customFieldContext.definitionsById.get(definitionId);
          auditRows.push({
            action: "testcase_custom_field_updated",
            entity_id: created.id,
            entity_name: `${created.external_id} - ${created.title}`,
            diff: {
              fieldId: definitionId,
              fieldKey: definition?.key,
              fieldName: definition?.name,
              before: null,
              after: value
            }
          });
        }
      }
    }

    if (valueRows.length) {
      await client.query(
        `INSERT INTO custom_field_values (definition_id, testcase_id, value, created_by, updated_by)
         SELECT v.definition_id, v.testcase_id, v.value, $1, $1
         FROM jsonb_to_recordset($2::jsonb) AS v(definition_id uuid, testcase_id uuid, value jsonb)
         ON CONFLICT (definition_id, testcase_id) DO UPDATE
           SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [ctx.uid, JSON.stringify(valueRows)]
      );
    }

    if (auditRows.length) {
      // Both kinds of entry go in together — one statement for the chunk in place of
      // logProjectActivity's insert per test case and per changed field.
      await client.query(
        `INSERT INTO audit_logs (project_id, actor_id, action, entity_type, entity_id, entity_name, diff, organization_id)
         SELECT $1, $2, v.action, 'testcase', v.entity_id, v.entity_name, v.diff, $3
         FROM jsonb_to_recordset($4::jsonb) AS v(action text, entity_id uuid, entity_name text, diff jsonb)`,
        [ctx.projectId, ctx.uid, ctx.organizationId, JSON.stringify(auditRows)]
      );
    }

    return inserted.rowCount ?? inserted.rows.length;
  }

  /**
   * The slow path, taken only after a batch insert was rejected: the same rows again, one at a time,
   * each inside its own SAVEPOINT so the failure can be pinned on the row that caused it.
   *
   * A chunk of one goes through exactly the same code as a chunk of a thousand, which is the point —
   * there is no second implementation of the insert to keep in step with the first.
   */
  private async insertImportRowsIndividually(
    client: PoolClient,
    ctx: ImportContext,
    prepared: PreparedImportRow[],
    startNumber: number
  ): Promise<{ imported: number; errors: { row: number; message: string }[] }> {
    const errors: { row: number; message: string }[] = [];
    let imported = 0;
    let nextNumber = startNumber;

    for (const row of prepared) {
      const suiteSnapshot = new Map(ctx.suiteIdByKey);
      const expandSnapshot = new Set(ctx.expandSuiteIds);
      await client.query("SAVEPOINT import_row");
      try {
        await this.resolveImportSuites(client, ctx, [row]);
        await this.insertImportChunk(client, ctx, [row], nextNumber);
        await client.query("RELEASE SAVEPOINT import_row");
        // Advanced only once the row is safely in, so a rejected row leaves no gap in the numbering.
        nextNumber += 1;
        imported += 1;
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT import_row");
        await client.query("RELEASE SAVEPOINT import_row");
        ctx.suiteIdByKey.clear();
        for (const [key, id] of suiteSnapshot) ctx.suiteIdByKey.set(key, id);
        ctx.expandSuiteIds.clear();
        for (const id of expandSnapshot) ctx.expandSuiteIds.add(id);
        errors.push({ row: row.rowNumber, message: this.importRowErrorMessage(ctx.projectId, row.rowNumber, error) });
      }
    }

    return { imported, errors };
  }

  /**
   * The one line the import result shows against a row that failed.
   *
   * Validation rejections carry a message written for the person importing, so those are passed
   * through. Anything else is a driver or constraint error whose text describes our schema, not their
   * spreadsheet — it gets logged and reported generically rather than shipped to the browser.
   */
  private importRowErrorMessage(projectId: string, rowNumber: number, error: unknown): string {
    if (error instanceof HttpException) {
      const response = error.getResponse() as
        | string
        | { error?: string; message?: unknown; errors?: { message?: string }[] };
      if (typeof response === "string") return response;
      if (response?.error) return String(response.error);
      const fieldErrors = Array.isArray(response?.errors)
        ? response.errors.map((entry) => entry?.message).filter(Boolean)
        : [];
      if (fieldErrors.length) return fieldErrors.join("; ");
      if (response?.message) return String(response.message);
    }
    this.logger.warn(
      `Import row ${rowNumber} failed for project ${projectId}: ${error instanceof Error ? error.message : String(error)}`
    );
    return "Failed to import row";
  }

  // Extracted for the same reason as insertTestCaseWithClient above — lets a multi-row Zyra
  // review-batch save run several updates atomically with each other (and with any creates in the
  // same batch) against one shared client, instead of one transaction per row.
  private async updateTestCaseWithClient(client: PoolClient, projectId: string, id: string, uid: string, body: Body) {
    const res = await client.query(
      `UPDATE testcases SET
       suite_id=$2, title=COALESCE($3,title), description=COALESCE($4,description),
       preconditions=COALESCE($5,preconditions), postconditions=COALESCE($6,postconditions),
       steps=COALESCE($7::jsonb,steps), test_data=COALESCE($8,test_data), priority=COALESCE($9,priority),
       severity=COALESCE($10,severity), type=COALESCE($11,type), automation_status=COALESCE($12,automation_status),
       automation_repo=COALESCE($13,automation_repo), automation_path=COALESCE($14,automation_path),
       automation_test_name=COALESCE($15,automation_test_name), automation_framework=COALESCE($16,automation_framework),
       automation_tags=COALESCE($17,automation_tags), owner_id=$18, component=COALESCE($19,component),
       status=COALESCE($20,status), jira_issue_key=COALESCE($21,jira_issue_key), jira_url=COALESCE($22,jira_url),
       linear_issue_key=COALESCE($23,linear_issue_key), linear_url=COALESCE($24,linear_url),
       attachments=COALESCE($25,attachments), updated_by=$26,
       estimated_duration=COALESCE($27,estimated_duration), updated_at=now()
       WHERE id=$1 AND deleted_at IS NULL
       RETURNING *`,
      [
        id,
        body.suiteId ?? null,
        body.title ?? null,
        body.description ?? null,
        body.preconditions ?? null,
        body.postconditions ?? null,
        body.steps || body.stepsJson ? JSON.stringify(body.steps || body.stepsJson) : null,
        body.testData ?? null,
        body.priority ?? null,
        body.severity ?? null,
        body.type ?? null,
        body.automationStatus ?? null,
        body.automationRepo ?? null,
        body.automationPath ?? null,
        body.automationTestName ?? null,
        body.automationFramework ?? null,
        body.automationTags ?? null,
        body.ownerId ?? null,
        body.component ?? null,
        body.status ?? null,
        body.jiraIssueKey ?? null,
        body.jiraUrl ?? null,
        body.linearIssueKey ?? null,
        body.linearUrl ?? null,
        body.attachments ?? null,
        uid,
        this.normalizeEstimatedDuration(body.estimatedDuration)
      ]
    );
    const row = res.rows[0];
    // Always called (even with an empty body.customFieldValues) so required-field
    // enforcement re-checks against currently-active-required fields using existing
    // stored values — correct for "field made required after the fact".
    await this.customFields.setValuesForTestCase(uid, projectId, id, body.customFieldValues || {}, client, "skip-if-disabled");
    return row;
  }

  async updateTestCase(id: string, actorId: string | null | undefined, body: Body) {
    const uid = this.requireUser(actorId);
    // Same guard as create: an over-long value here hit the bounded column and answered 500.
    this.assertTestcaseFieldLengths(body);
    const before = await this.db.query("SELECT * FROM testcases WHERE id = $1 AND deleted_at IS NULL", [id]);
    if (!before.rows[0]) throw new NotFoundException({ error: "Test case not found" });
    const projectId = before.rows[0].project_id;
    const after = await this.db.transaction(async (client) => this.updateTestCaseWithClient(client, projectId, id, uid, body));
    await this.logProjectActivity(projectId, uid, "testcase_updated", "testcase", id, `${after?.external_id} - ${after?.title}`, {
      before: toCamel(before.rows[0]),
      after: toCamel(after)
    });
  }

  // No duplicate/clone endpoint existed before this feature. Added so "custom field
  // values are preserved when a test case is duplicated" (spec requirement) is actually
  // satisfiable end-to-end, rather than a requirement about an operation that didn't exist.
  async duplicateTestCase(id: string, actorId: string | null | undefined): Promise<Body> {
    const uid = this.requireUser(actorId);
    const source = await this.db.query("SELECT * FROM testcases WHERE id = $1 AND deleted_at IS NULL", [id]);
    if (!source.rows[0]) throw new NotFoundException({ error: "Test case not found" });
    const src = source.rows[0];
    const externalId = await this.nextExternalId(src.project_id);

    const duplicated = await this.db.transaction(async (client) => {
      const res = await client.query(
        `INSERT INTO testcases
         (project_id, suite_id, external_id, title, description, preconditions, postconditions, steps, test_data,
          priority, severity, type, automation_status, automation_repo, automation_path, automation_test_name,
          automation_framework, automation_tags, owner_id, component, status, jira_issue_key, jira_url,
          linear_issue_key, linear_url, attachments, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$27)
         RETURNING *`,
        [
          src.project_id,
          src.suite_id,
          externalId,
          `${src.title} (copy)`,
          src.description,
          src.preconditions,
          src.postconditions,
          JSON.stringify(src.steps || []),
          src.test_data,
          src.priority,
          src.severity,
          src.type,
          src.automation_status,
          src.automation_repo,
          src.automation_path,
          src.automation_test_name,
          src.automation_framework,
          src.automation_tags,
          src.owner_id,
          src.component,
          src.status,
          src.jira_issue_key,
          src.jira_url,
          src.linear_issue_key,
          src.linear_url,
          src.attachments,
          uid
        ]
      );
      const row = res.rows[0];
      await this.customFields.copyValues(id, row.id, uid, client);
      return row;
    });

    await this.logProjectActivity(src.project_id, uid, "testcase_duplicated", "testcase", duplicated.id, `${duplicated.external_id} - ${duplicated.title}`, {
      sourceId: id
    });
    return toCamel(duplicated);
  }

  async deleteTestCase(id: string, actorId: string | null | undefined) {
    const uid = this.requireUser(actorId);
    const before = await this.db.query("SELECT * FROM testcases WHERE id = $1 AND deleted_at IS NULL", [id]);
    if (!before.rows[0]) throw new NotFoundException({ error: "Test case not found" });
    await this.db.query(
      "UPDATE testcases SET deleted_at = now(), deleted_by = $2, updated_by = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL",
      [id, uid]
    );
    await this.logProjectActivity(before.rows[0].project_id, uid, "testcase_deleted", "testcase", id, `${before.rows[0].external_id} - ${before.rows[0].title}`, {
      before: toCamel(before.rows[0])
    });
  }

  async bulkUpdateTestCases(projectId: string, actorId: string | null | undefined, body: Body) {
    const uid = this.requireUser(actorId);
    await this.requireProjectAccess(uid, projectId);
    const ids = Array.isArray(body.testcaseIds) ? body.testcaseIds : [];
    if (!ids.length) return;
    // Bulk writes priority/status/automationStatus into the same bounded columns as a single update,
    // so it needs the same guard — otherwise the 500 is simply reachable a different way.
    this.assertTestcaseFieldLengths(body);
    /*
     * `suiteId: "none"` clears the suite; an absent suiteId leaves it alone.
     *
     * COALESCE alone cannot express the difference, and the repository's bulk-move modal offers
     * "Unassigned (no suite)" as its first option — which sent an empty string, became `undefined`, and
     * then COALESCE'd back to the case's existing suite. So choosing it moved nothing at all while the
     * modal reported success, and the suite counts did not budge: Basecamp 10194174342, "test cases
     * count and test cases discrepancy after suite move".
     *
     * "none" is the same sentinel listTestCases reads as `suite_id IS NULL`, so the value that filters
     * to unfiled cases is also the value that makes a case unfiled.
     */
    const clearSuite = String(body.suiteId ?? "").toLowerCase() === "none";
    await this.db.query(
      `UPDATE testcases SET priority=COALESCE($2,priority),
       suite_id = CASE WHEN $8::boolean THEN NULL ELSE COALESCE($3::uuid, suite_id) END,
       status=COALESCE($4,status), owner_id=COALESCE($5,owner_id), automation_status=COALESCE($6,automation_status),
       updated_by=$7, updated_at=now()
       WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [
        ids,
        body.priority || null,
        clearSuite ? null : body.suiteId || null,
        body.status || null,
        body.ownerId || null,
        body.automationStatus || null,
        uid,
        clearSuite
      ]
    );
    await this.logProjectActivity(projectId, uid, "testcase_bulk_updated", "testcase", null, null, {
      testcaseIds: ids,
      fields: { priority: body.priority || null, suiteId: body.suiteId || null, status: body.status || null, ownerId: body.ownerId || null, automationStatus: body.automationStatus || null }
    });
  }

  async bulkDeleteTestCases(projectId: string, actorId: string | null | undefined, ids: string[]) {
    const uid = this.requireUser(actorId);
    await this.requireProjectAccess(uid, projectId);
    if (!ids.length) return;
    await this.db.query(
      "UPDATE testcases SET deleted_at = now(), deleted_by = $2, updated_by = $2, updated_at = now() WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL",
      [ids, uid]
    );
    await this.logProjectActivity(projectId, uid, "testcase_bulk_deleted", "testcase", null, null, { testcaseIds: ids });
  }

  async linkedJiraKeys(projectId: string, userId?: string | null) {
    await this.requireProjectAccess(userId, projectId);
    const res = await this.db.query(
      "SELECT jira_issue_key, COUNT(*)::int AS count FROM testcases WHERE project_id = $1 AND jira_issue_key IS NOT NULL AND deleted_at IS NULL GROUP BY jira_issue_key",
      [projectId]
    );
    const keys = res.rows.map((r) => r.jira_issue_key);
    return { keys, counts: Object.fromEntries(res.rows.map((r) => [r.jira_issue_key, r.count])) };
  }

  async linkedLinearKeys(projectId: string, userId?: string | null) {
    await this.requireProjectAccess(userId, projectId);
    const res = await this.db.query(
      "SELECT linear_issue_key, COUNT(*)::int AS count FROM testcases WHERE project_id = $1 AND linear_issue_key IS NOT NULL AND deleted_at IS NULL GROUP BY linear_issue_key",
      [projectId]
    );
    const keys = res.rows.map((r) => r.linear_issue_key);
    return { keys, counts: Object.fromEntries(res.rows.map((r) => [r.linear_issue_key, r.count])) };
  }

  /**
   * Resolves a plan and confirms the caller may reach the project it belongs to.
   *
   * /api/plans/* is addressed by plan id with no project in the URL — get, update, delete, its items,
   * its runs and its progress rollup all took no caller at all, so a guessed plan id exposed the
   * project's test coverage and let anyone rewrite or delete the plan.
   */
  private async requirePlanAccess(userId: string | null | undefined, planId: string): Promise<string> {
    const uid = this.requireUser(userId);
    if (!isUuid(planId)) throw new NotFoundException({ error: "Plan not found" });
    const res = await this.db.query<{ project_id: string }>("SELECT project_id FROM plans WHERE id = $1", [planId]);
    if (!res.rows[0]) throw new NotFoundException({ error: "Plan not found" });
    await this.requireProjectAccess(uid, res.rows[0].project_id);
    return res.rows[0].project_id;
  }

  /**
   * Resolves a plan item's plan, then that plan's project.
   *
   * DELETE /api/plans/:planId/items/:itemId is authorized on the plan in the URL, but the item id is
   * the thing being deleted — so the item has to be confirmed to belong to that plan, or a caller
   * authorized for their own plan could delete an item out of someone else's.
   */
  private async requirePlanItemAccess(userId: string | null | undefined, planId: string, itemId: string) {
    await this.requirePlanAccess(userId, planId);
    if (!isUuid(itemId)) throw new NotFoundException({ error: "Plan item not found" });
    const res = await this.db.query("SELECT id FROM plan_items WHERE id = $1 AND plan_id = $2", [itemId, planId]);
    if (!res.rows[0]) throw new NotFoundException({ error: "Plan item not found" });
  }

  /**
   * The status buckets every "how far along is this run" counter in the product is built from.
   *
   * Shared rather than repeated because the plan screens and the runs screen were computing the same
   * numbers three different ways, and a user comparing two screens saw two answers for one run:
   *
   * - Counted off `e.id`, not `ci.id`. A cycle_item with no live execution row renders nowhere (the
   *   run's own table INNER JOINs executions), so counting items let it inflate the total on the
   *   plan screen alone. It also keeps a cycle with no items at all out of every bucket: under
   *   `COUNT(*)` the LEFT JOIN's placeholder row scored as one untested case, which is how a plan
   *   holding an empty run reported more untested cases than it had cases.
   * - Joined with `deleted_at IS NULL`. Executions soft-delete, and a deleted result is not a
   *   result; leaving it in double-counted the case it belonged to.
   * - Every status lands in exactly one bucket, so the buckets always sum to total_cases. Retest
   *   belongs with untested: a case sent back for retest has no settled result for this run, and
   *   giving it no bucket at all is what made these counters sum to less than the total.
   *
   * Callers supply the joins: LEFT JOIN cycle_items ci, then LEFT JOIN executions e ON
   * e.cycle_item_id = ci.id AND e.deleted_at IS NULL.
   */
  private static readonly EXECUTION_BUCKET_COUNTS = `COUNT(e.id)::int AS total_cases,
              COUNT(e.id) FILTER (WHERE e.status = 'Passed')::int AS passed,
              COUNT(e.id) FILTER (WHERE e.status = 'Failed')::int AS failed,
              COUNT(e.id) FILTER (WHERE e.status = 'Blocked')::int AS blocked,
              COUNT(e.id) FILTER (WHERE e.status = 'Skipped')::int AS skipped,
              COUNT(e.id) FILTER (WHERE e.status IN ('Untested', 'Retest'))::int AS untested`;

  /**
   * The one formula for "Pass Rate" and "Execution Progress", used by every endpoint that reports
   * either number (plans, cycles, projects list, dashboard, reports). Before this existed each
   * caller reimplemented its own division, and they disagreed on two things: whether a Skipped case
   * belongs in the denominator, and whether Retest counts as executed. That produced, for the exact
   * same run, a Test Run Details page reading 30% and a Test Plan page reading 43%.
   *
   * - Pass Rate = Passed / (Passed + Failed + Blocked). A case that was deliberately Skipped has no
   *   pass/fail verdict, so it is excluded from both sides of this ratio — it neither helps nor hurts
   *   the rate. null when nothing has a settled verdict yet, so an all-pending or all-skipped run
   *   renders as "—" rather than a misleading 0%.
   * - Execution Progress = (Passed + Failed + Blocked + Skipped) / Total. Skipped IS counted here: it
   *   is a deliberate outcome, not work still to do, so it belongs in "how much of this run is done".
   * - Retest is never executed for either metric — it belongs with Untested (see the comment on
   *   EXECUTION_BUCKET_COUNTS), so callers must not add it into passed/failed/blocked/skipped.
   */
  private static computeExecutionMetrics(counts: {
    passed: number;
    failed: number;
    blocked: number;
    skipped: number;
    totalCases: number;
  }): { executed: number; pending: number; passRate: number | null; executionProgress: number } {
    const passed = counts.passed || 0;
    const failed = counts.failed || 0;
    const blocked = counts.blocked || 0;
    const skipped = counts.skipped || 0;
    const totalCases = counts.totalCases || 0;
    const settled = passed + failed + blocked;
    const executed = settled + skipped;
    return {
      executed,
      pending: Math.max(0, totalCases - executed),
      passRate: settled > 0 ? Math.round((passed / settled) * 100) : null,
      executionProgress: totalCases > 0 ? Math.round((executed / totalCases) * 100) : 0
    };
  }

  async listPlansForUser(userId: string | null | undefined, projectId: string) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    return this.listPlans(projectId);
  }

  async listPlans(projectId: string) {
    const res = await this.db.query(
      `SELECT p.*,
              COALESCE(pi.case_count, 0)::int AS case_count,
              COALESCE(runs.run_count, 0)::int AS run_count,
              COALESCE(runs.passed, 0)::int AS passed,
              COALESCE(runs.failed, 0)::int AS failed,
              COALESCE(runs.blocked, 0)::int AS blocked,
              COALESCE(runs.skipped, 0)::int AS skipped,
              runs.last_run_at
       FROM plans p
       LEFT JOIN (
         SELECT plan_id, COUNT(*)::int AS case_count
         FROM plan_items
         GROUP BY plan_id
       ) pi ON pi.plan_id = p.id
       LEFT JOIN (
         SELECT c.plan_id,
                COUNT(DISTINCT c.id)::int AS run_count,
                COUNT(e.id) FILTER (WHERE e.status = 'Passed')::int AS passed,
                COUNT(e.id) FILTER (WHERE e.status = 'Failed')::int AS failed,
                COUNT(e.id) FILTER (WHERE e.status = 'Blocked')::int AS blocked,
                COUNT(e.id) FILTER (WHERE e.status = 'Skipped')::int AS skipped,
                MAX(COALESCE(c.started_at, c.created_at)) AS last_run_at
         FROM cycles c
         LEFT JOIN cycle_items ci ON ci.cycle_id = c.id
         LEFT JOIN executions e ON e.cycle_item_id = ci.id AND e.deleted_at IS NULL
         WHERE c.plan_id IS NOT NULL
         GROUP BY c.plan_id
       ) runs ON runs.plan_id = p.id
       WHERE p.project_id = $1
       ORDER BY p.created_at DESC`,
      [projectId]
    );
    return res.rows.map(toCamel);
  }

  async createPlan(userId: string | null | undefined, projectId: string, body: Body) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    validateBoundedField(body.name, "Plan name", PLAN_NAME_MAX_LENGTH);
    validateBoundedField(body.targetRelease, "Target release", PLAN_TARGET_RELEASE_MAX_LENGTH);
    const res = await this.db.query(
      "INSERT INTO plans (project_id, name, description, target_release, owner_id) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [projectId, body.name || "Untitled plan", body.description || "", body.targetRelease || null, body.ownerId || null]
    );
    return toCamel(res.rows[0]);
  }

  async getPlan(userId: string | null | undefined, planId: string) {
    await this.requirePlanAccess(userId, planId);
    const res = await this.db.query("SELECT * FROM plans WHERE id = $1", [planId]);
    if (!res.rows[0]) throw new NotFoundException({ error: "Plan not found" });
    return toCamel(res.rows[0]);
  }

  async updatePlan(userId: string | null | undefined, planId: string, body: Body) {
    await this.requirePlanAccess(userId, planId);
    validateBoundedField(body.name, "Plan name", PLAN_NAME_MAX_LENGTH);
    validateBoundedField(body.targetRelease, "Target release", PLAN_TARGET_RELEASE_MAX_LENGTH);
    await this.db.query(
      "UPDATE plans SET name=COALESCE($2,name), description=COALESCE($3,description), target_release=COALESCE($4,target_release), updated_at=now() WHERE id=$1",
      [planId, body.name || null, body.description || null, body.targetRelease || null]
    );
  }

  async deletePlan(userId: string | null | undefined, planId: string) {
    await this.requirePlanAccess(userId, planId);
    await this.db.query("DELETE FROM plans WHERE id = $1", [planId]);
  }

  async planItems(userId: string | null | undefined, planId: string) {
    await this.requirePlanAccess(userId, planId);
    return this.planItemRows(planId);
  }

  private async planItemRows(planId: string) {
    const res = await this.db.query(
      `SELECT pi.*,
              t.external_id AS tc_external_id, t.title AS tc_title, t.priority AS tc_priority,
              s.name AS suite_name,
              lastex.status AS last_status
       FROM plan_items pi
       LEFT JOIN testcases t ON t.id = pi.testcase_id
       LEFT JOIN suites s ON s.id = pi.suite_id
       LEFT JOIN LATERAL (
         SELECT e.status
         FROM cycles c
         JOIN cycle_items ci ON ci.cycle_id = c.id AND ci.testcase_id = pi.testcase_id
         JOIN executions e ON e.cycle_item_id = ci.id AND e.deleted_at IS NULL
         WHERE c.plan_id = pi.plan_id
         ORDER BY e.executed_at DESC NULLS LAST, e.created_at DESC
         LIMIT 1
       ) lastex ON pi.testcase_id IS NOT NULL
       WHERE pi.plan_id = $1
       ORDER BY pi.position, pi.created_at`,
      [planId]
    );
    return res.rows.map(toCamel);
  }

  async addPlanItem(userId: string | null | undefined, planId: string, body: Body) {
    await this.requirePlanAccess(userId, planId);
    const res = await this.db.query(
      "INSERT INTO plan_items (plan_id, suite_id, testcase_id, position) VALUES ($1,$2,$3,$4) RETURNING *",
      [planId, body.suiteId || null, body.testcaseId || null, body.position || 0]
    );
    return toCamel(res.rows[0]);
  }

  async deletePlanItem(userId: string | null | undefined, planId: string, itemId: string) {
    await this.requirePlanItemAccess(userId, planId, itemId);
    await this.db.query("DELETE FROM plan_items WHERE id = $1", [itemId]);
  }

  async planRuns(userId: string | null | undefined, planId: string) {
    await this.requirePlanAccess(userId, planId);
    return this.planRunRows(planId);
  }

  private async planRunRows(planId: string) {
    const res = await this.db.query(
      // Counted exactly like listCycles, so one run cannot report a different case count on the plan
      // screen than on the runs screen it links to.
      `SELECT c.*,
              ${LegacyService.EXECUTION_BUCKET_COUNTS}
       FROM cycles c
       LEFT JOIN cycle_items ci ON ci.cycle_id = c.id
       LEFT JOIN executions e ON e.cycle_item_id = ci.id AND e.deleted_at IS NULL
       WHERE c.plan_id = $1
       GROUP BY c.id
       ORDER BY c.created_at DESC`,
      [planId]
    );
    return res.rows.map(toCamel);
  }

  async planProgress(userId: string | null | undefined, planId: string) {
    await this.requirePlanAccess(userId, planId);
    return this.planProgressRollup(planId);
  }

  private async planProgressRollup(planId: string) {
    const res = await this.db.query<{
      run_count: number;
      total_cases: number;
      passed: number;
      failed: number;
      blocked: number;
      skipped: number;
      untested: number;
    }>(
      // The plan header is the sum of the rows planRunRows returns, counted the same way, so the
      // tiles always add up to total_cases and always agree with the runs listed beneath them.
      `SELECT COUNT(DISTINCT c.id)::int AS run_count,
              ${LegacyService.EXECUTION_BUCKET_COUNTS}
       FROM cycles c
       LEFT JOIN cycle_items ci ON ci.cycle_id = c.id
       LEFT JOIN executions e ON e.cycle_item_id = ci.id AND e.deleted_at IS NULL
       WHERE c.plan_id = $1`,
      [planId]
    );
    const row = res.rows[0] ?? {
      run_count: 0,
      total_cases: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
      skipped: 0,
      untested: 0
    };
    const totalCases = Number(row.total_cases) || 0;
    const passed = Number(row.passed) || 0;
    const failed = Number(row.failed) || 0;
    const blocked = Number(row.blocked) || 0;
    const skipped = Number(row.skipped) || 0;
    const untested = Number(row.untested) || 0;
    const metrics = LegacyService.computeExecutionMetrics({ passed, failed, blocked, skipped, totalCases });
    return {
      runCount: Number(row.run_count) || 0,
      totalCases,
      passed,
      failed,
      blocked,
      skipped,
      untested,
      executed: metrics.executed,
      passRate: metrics.passRate,
      completionPercent: metrics.executionProgress
    };
  }

  async listCyclesForUser(userId: string | null | undefined, projectId: string) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    return this.listCycles(projectId);
  }

  async listCycles(projectId: string) {
    const res = await this.db.query(
      // Counted off the live execution rows, matching executions() exactly, so the number shown
      // on the run card can never disagree with the number of rows the run's own table renders.
      // Counting cycle_items instead let anything without a live execution inflate the card.
      `SELECT c.*,
              ${LegacyService.EXECUTION_BUCKET_COUNTS}
       FROM cycles c
       LEFT JOIN cycle_items ci ON ci.cycle_id = c.id
       LEFT JOIN executions e ON e.cycle_item_id = ci.id AND e.deleted_at IS NULL
       WHERE c.project_id = $1
       GROUP BY c.id
       ORDER BY c.created_at DESC`,
      [projectId]
    );
    return res.rows.map(toCamel);
  }

  async createCycleForUser(userId: string | null | undefined, projectId: string, body: Body) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    return this.createCycle(projectId, body);
  }

  /**
   * The insert itself, without a caller check.
   *
   * Kept unguarded for the MCP tool, whose API token is already bound to one project. Route traffic
   * goes through createCycleForUser.
   */
  async createCycle(projectId: string, body: Body) {
    validateBoundedField(body.name, "Test run name", CYCLE_NAME_MAX_LENGTH);
    validateBoundedField(body.environment, "Environment", CYCLE_LABEL_MAX_LENGTH);
    validateBoundedField(body.buildVersion, "Build version", CYCLE_LABEL_MAX_LENGTH);
    validateBoundedField(body.releaseName, "Release name", CYCLE_LABEL_MAX_LENGTH);
    const res = await this.db.query(
      `INSERT INTO cycles (project_id, plan_id, name, description, environment, build_version, release_name, owner_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        projectId,
        body.planId || null,
        body.name || "Untitled cycle",
        body.description || "",
        body.environment || null,
        body.buildVersion || null,
        body.releaseName || null,
        body.ownerId || null
      ]
    );
    return toCamel(res.rows[0]);
  }

  /**
   * Resolves a run and confirms the caller may reach the project it belongs to.
   *
   * /api/cycles/* is addressed by cycle id with no project in the URL, so every handler here has to
   * resolve the project itself. They did not: getCycle, updateCycle, deleteCycle, executions,
   * shareCycle and the cycle_items routes took no caller at all, which the comment above
   * exportCycleExecutions already recorded as an open gap. A run carries case titles, actual results
   * and linked defect keys, DELETE removes it outright, and share mints a public URL to it.
   */
  /** requireCycleAccess for controller-level guards that have no service call to hang it off. */
  async requireCycleAccessForUser(userId: string | null | undefined, cycleId: string): Promise<string> {
    return this.requireCycleAccess(userId, cycleId);
  }

  private async requireCycleAccess(userId: string | null | undefined, cycleId: string): Promise<string> {
    const uid = this.requireUser(userId);
    // Same answer for a malformed id as for one that doesn't exist — see requireProjectAccess.
    if (!isUuid(cycleId)) throw new NotFoundException({ error: "Cycle not found" });
    const res = await this.db.query<{ project_id: string }>("SELECT project_id FROM cycles WHERE id = $1", [cycleId]);
    if (!res.rows[0]) throw new NotFoundException({ error: "Cycle not found" });
    await this.requireProjectAccess(uid, res.rows[0].project_id);
    return res.rows[0].project_id;
  }

  async getCycle(cycleId: string, userId?: string | null) {
    await this.requireCycleAccess(userId, cycleId);
    const res = await this.db.query("SELECT * FROM cycles WHERE id = $1", [cycleId]);
    if (!res.rows[0]) throw new NotFoundException({ error: "Cycle not found" });
    return toCamel(res.rows[0]);
  }

  async shareCycle(cycleId: string, userId: string | null | undefined, body: Body) {
    await this.requireCycleAccess(userId, cycleId);
    const enabled = body.enabled !== false;
    const existing = await this.db.query("SELECT id, share_token FROM cycles WHERE id = $1", [cycleId]);
    if (!existing.rows[0]) throw new NotFoundException({ error: "Cycle not found" });
    const shareToken = existing.rows[0].share_token || randomBytes(24).toString("hex");
    const res = await this.db.query(
      "UPDATE cycles SET share_enabled = $2, share_token = $3, updated_at = now() WHERE id = $1 RETURNING share_enabled, share_token",
      [cycleId, enabled, shareToken]
    );
    return {
      shareEnabled: Boolean(res.rows[0]?.share_enabled),
      shareToken: res.rows[0]?.share_token || null
    };
  }

  async publicCycle(token: string) {
    const res = await this.db.query("SELECT * FROM cycles WHERE share_token = $1 AND share_enabled = true", [token]);
    if (!res.rows[0]) throw new NotFoundException({ error: "Shared run not found" });
    return toCamel(res.rows[0]);
  }

  /**
   * The rows behind a public share link.
   *
   * Deliberately NOT this.executions(): that projection carries the full test case body — steps,
   * preconditions, postconditions, test data, description — plus the tester's actual_result, the
   * assignee, and the linked defect key and URL. A share link is unauthenticated by design and gets
   * forwarded into tickets and chats, so everything it returns should be treated as published.
   *
   * The columns below are exactly the six the share page renders (app/share/[token]/page.tsx): the
   * status badge, the external id, the title, the priority and the type. Anything a future column
   * needs has to be added here on purpose, which is the point — the previous shape leaked by default.
   */
  async publicCycleExecutions(token: string) {
    const run = await this.db.query("SELECT id FROM cycles WHERE share_token = $1 AND share_enabled = true", [token]);
    if (!run.rows[0]) throw new NotFoundException({ error: "Shared run not found" });
    const res = await this.db.query(
      `SELECT e.id, e.status,
              COALESCE(NULLIF(ci.snapshot_title, ''), NULLIF(t.title, ''), 'Untitled test case') AS title,
              t.external_id, t.priority, t.type
       FROM cycle_items ci JOIN executions e ON e.cycle_item_id = ci.id
       LEFT JOIN testcases t ON t.id = ci.testcase_id AND t.deleted_at IS NULL
       WHERE ci.cycle_id = $1 AND e.deleted_at IS NULL ORDER BY ci.position, ci.created_at`,
      [run.rows[0].id]
    );
    return res.rows.map(toCamel);
  }

  async updateCycle(cycleId: string, userId: string | null | undefined, body: Body) {
    await this.requireCycleAccess(userId, cycleId);
    validateBoundedField(body.name, "Test run name", CYCLE_NAME_MAX_LENGTH);
    validateBoundedField(body.environment, "Environment", CYCLE_LABEL_MAX_LENGTH);
    validateBoundedField(body.buildVersion, "Build version", CYCLE_LABEL_MAX_LENGTH);
    validateBoundedField(body.releaseName, "Release name", CYCLE_LABEL_MAX_LENGTH);
    /*
     * Basecamp 10221952787 ("[Test Run] history not showing when test was run").
     *
     * `cycles.started_at` and `cycles.ended_at` have existed since the first migration and were
     * never written by ANY code path — only read. The runs list renders a clock reading
     * formatDuration(startedAt, endedAt), so every run in the product showed "—", including
     * completed ones with results on screen. Nothing was broken in the UI; there was simply no data
     * that could ever arrive.
     *
     * They are stamped from the status transition, which is what the Start and Mark Completed
     * buttons drive:
     *   → In Progress  starts the clock (first time only) and reopens a run that had finished
     *   → Completed    stops it, and back-fills a start for a run taken straight to Completed,
     *                  so a duration is never computed from a null start
     *   → Planning     leaves the original start alone but clears the end: it is not finished
     */
    const status = typeof body.status === "string" ? body.status : null;
    await this.db.query(
      `UPDATE cycles SET name=COALESCE($2,name), description=COALESCE($3,description),
       environment=COALESCE($4,environment), build_version=COALESCE($5,build_version),
       release_name=COALESCE($6,release_name),
       plan_id=CASE WHEN $7::boolean THEN NULL WHEN $8::uuid IS NOT NULL THEN $8::uuid ELSE plan_id END,
       status=COALESCE($9,status),
       started_at=CASE WHEN $9 IN ('In Progress', 'Completed') THEN COALESCE(started_at, now()) ELSE started_at END,
       ended_at=CASE WHEN $9 = 'Completed' THEN now() WHEN $9 IN ('In Progress', 'Planning') THEN NULL ELSE ended_at END,
       updated_at=now() WHERE id=$1`,
      [
        cycleId,
        body.name || null,
        body.description || null,
        body.environment || null,
        body.buildVersion || null,
        body.releaseName || null,
        body.clearPlan === true,
        body.planId || null,
        status
      ]
    );
  }

  async deleteCycle(cycleId: string, userId?: string | null) {
    await this.requireCycleAccess(userId, cycleId);
    await this.db.query("DELETE FROM cycles WHERE id = $1", [cycleId]);
  }

  /**
   * Adds a selection of test cases to a run, as one statement.
   *
   * This used to loop over the selection and issue three sequential round trips per case — read the
   * title, insert the cycle_item, insert its execution. The UI sends the whole selection in a single
   * POST, so "select all" on a project with a couple of thousand cases became several thousand
   * serialized queries and ran for minutes; in production Cloudflare gave up at its 100s proxy limit
   * and the browser saw a 524.
   *
   * The timeout was the visible half. The loop also committed one case at a time, so a request that
   * died partway left the cases it had already written behind — a run holding an arbitrary prefix of
   * the selection, with nothing to say where it stopped. Doing the whole thing in one statement makes
   * it atomic: the run either gains the full selection or none of it.
   */
  async addCycleTestCases(cycleId: string, userId: string | null | undefined, body: Body) {
    const projectId = await this.requireCycleAccess(userId, cycleId);
    const raw = body.testcaseIds || (body.testcaseId ? [body.testcaseId] : []);

    // Malformed ids used to reach Postgres as `WHERE id = $1` against a uuid column and fail the
    // request with a driver error; unknown ones were skipped. Both are dropped here so a single bad
    // id in a large selection cannot 500 the whole add, and `= ANY($2::uuid[])` never sees a value
    // it cannot cast.
    // `requested` is the raw selection size, so added + skipped always accounts for every id the
    // caller sent — including duplicates and ids dropped as malformed below.
    const requested = normalizeJsonArray(raw).length;
    const ids = [...new Set(normalizeJsonArray(raw).map((id) => String(id)).filter((id) => isUuid(id)))];
    if (!ids.length) return { requested, added: 0, skipped: requested };

    const res = await this.db.query<{ id: string }>(
      `WITH input AS (
         SELECT id, ord FROM unnest($2::uuid[]) WITH ORDINALITY AS u(id, ord)
       ),
       base AS (
         SELECT COALESCE(MAX(position), 0) AS pos FROM cycle_items WHERE cycle_id = $1
       ),
       ins AS (
         -- t.project_id = $3 is a tenancy check, not a filter for convenience. The old lookup
         -- resolved each case by id alone, so any authenticated caller could name a test case
         -- belonging to another workspace and have this run adopt it — copying that tenant's title
         -- into snapshot_title on the way. requireCycleAccess already resolved the run's project, so
         -- scope the join to it and let a foreign id fall out with the unknown ones.
         INSERT INTO cycle_items (cycle_id, testcase_id, snapshot_title, position)
         SELECT $1, t.id, t.title, base.pos + i.ord
           FROM input i
           JOIN testcases t ON t.id = i.id AND t.deleted_at IS NULL AND t.project_id = $3
           CROSS JOIN base
         ON CONFLICT (cycle_id, testcase_id) DO NOTHING
         RETURNING id
       )
       INSERT INTO executions (cycle_item_id)
       SELECT id FROM ins
       ON CONFLICT (cycle_item_id) DO NOTHING
       RETURNING id`,
      [cycleId, ids, projectId]
    );

    return { requested, added: res.rows.length, skipped: requested - res.rows.length };
  }

  async removeCycleTestCase(cycleId: string, userId: string | null | undefined, testcaseId: string) {
    await this.requireCycleAccess(userId, cycleId);
    if (!isUuid(testcaseId)) throw new NotFoundException({ error: "Test case not found" });
    await this.db.query("DELETE FROM cycle_items WHERE cycle_id = $1 AND testcase_id = $2", [cycleId, testcaseId]);
  }

  async removeCycleTestCases(cycleId: string, userId: string | null | undefined, body: Body) {
    // Guarded like every other /api/cycles/* route and like removeCycleTestCase above: without a
    // caller check a cycle id alone was enough to strip cases out of any workspace's run.
    await this.requireCycleAccess(userId, cycleId);
    const raw = body.testcaseIds || (body.testcaseId ? [body.testcaseId] : []);
    const requested = normalizeJsonArray(raw).length;
    // isUuid before the query, not after: a malformed id reaching `= ANY($2::uuid[])` fails the whole
    // request with a driver error, so one bad id in a large selection would 500 the entire remove.
    const ids = [...new Set(normalizeJsonArray(raw).map((id) => String(id)).filter((id) => isUuid(id)))];
    if (!ids.length) return { requested, removed: 0 };
    // Single statement for the whole selection — the alternative users were left with was one
    // DELETE per case (or dropping the entire run). executions cascade off cycle_items.
    const res = await this.db.query("DELETE FROM cycle_items WHERE cycle_id = $1 AND testcase_id = ANY($2::uuid[])", [cycleId, ids]);
    return { requested, removed: res.rowCount ?? 0 };
  }

  /** The guarded entry point for GET /api/cycles/:cycleId/executions. */
  async executionsForUser(cycleId: string, userId: string | null | undefined) {
    await this.requireCycleAccess(userId, cycleId);
    return this.executions(cycleId);
  }

  /**
   * The rows themselves, without a caller check.
   *
   * Kept unguarded for the two callers that have already decided access: exportCycleExecutions
   * (which authorizes first) and publicCycleExecutions (which is reached through a share token and
   * is deliberately public).
   */
  async executions(cycleId: string) {
    /*
     * The five e.* columns after defect_url and the evidence_count are what the automation ingest
     * writes (Basecamp 10189985971, V84). They are on the authenticated projection only —
     * publicCycleExecutions above has its own deliberately narrow column list, and an automated
     * run's error stack and CI provenance are not things a share link should publish.
     *
     * evidence_count is a count, not the file list: the run table renders a paperclip badge per
     * row, and fetching every attachment's metadata for a 500-case run to decide whether to draw
     * an icon would be 500 rows of payload for one integer. The list is fetched per execution when
     * the detail panel opens (listExecutionEvidence).
     *
     * The CSV export (exportCycleExecutions -> this method) is unaffected: it names its nine
     * headers explicitly rather than iterating the row's keys.
     */
    const res = await this.db.query(
      `SELECT e.id, e.status, e.assignee_id, e.actual_result, e.executed_at, e.defect_key, e.defect_url,
              e.duration_ms, e.retry_count, e.error_message, e.error_stack, e.reported_by,
              ci.id AS cycle_item_id, ci.testcase_id, ci.snapshot_title,
              COALESCE(NULLIF(ci.snapshot_title, ''), NULLIF(t.title, ''), 'Untitled test case') AS title,
              t.external_id, t.priority, t.type, t.suite_id, t.description, t.preconditions, t.postconditions,
              t.steps, t.test_data, t.automation_status, t.automation_tags,
              COALESCE(ev.count, 0)::int AS evidence_count
       FROM cycle_items ci JOIN executions e ON e.cycle_item_id = ci.id
       LEFT JOIN testcases t ON t.id = ci.testcase_id AND t.deleted_at IS NULL
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS count FROM attachments a
          WHERE a.entity_type = 'execution' AND a.entity_id = e.id
       ) ev ON true
       WHERE ci.cycle_id = $1 AND e.deleted_at IS NULL ORDER BY ci.position, ci.created_at`,
      [cycleId]
    );
    return res.rows.map(toCamel);
  }

  /** The statuses executions.status accepts. Anything else is refused before it reaches Postgres. */
  static readonly EXECUTION_STATUSES = ["Untested", "Passed", "Failed", "Blocked", "Skipped", "Retest"];

  /**
   * Resolves the executions a bulk request names, refusing the whole batch if any of them is not in
   * this run.
   *
   * Atomic on purpose, like the knowledge-base upload: a partial application leaves the caller unable
   * to tell which half of their selection took effect, and the UI offers these actions on a
   * multi-select where "some of them" is not a state the user can see.
   */
  private async resolveBulkExecutions(cycleId: string, body: Body): Promise<string[]> {
    const ids = normalizeJsonArray(body.executionIds).map((id) => String(id));
    if (!ids.length) throw new BadRequestException({ error: "executionIds is required" });
    if (!ids.every((id) => isUuid(id))) throw new NotFoundException({ error: "Execution not found" });
    const res = await this.db.query<{ id: string }>(
      `SELECT e.id FROM executions e JOIN cycle_items ci ON ci.id = e.cycle_item_id
       WHERE ci.cycle_id = $1 AND e.id = ANY($2::uuid[]) AND e.deleted_at IS NULL`,
      [cycleId, ids]
    );
    if (res.rows.length !== ids.length) throw new NotFoundException({ error: "Execution not found" });
    return res.rows.map((row) => row.id);
  }

  /**
   * Sets one status across a selection of a run's executions.
   *
   * The controller method was `bulkStatus() {}` — an empty body that answered 2xx and changed
   * nothing, so the UI's "mark selected as Passed" reported success and left every row Untested.
   */
  async bulkUpdateExecutionStatus(cycleId: string, userId: string | null | undefined, body: Body) {
    const uid = this.requireUser(userId);
    await this.requireCycleAccess(uid, cycleId);
    const status = String(body.status || "").trim();
    if (!LegacyService.EXECUTION_STATUSES.includes(status)) {
      throw new BadRequestException({
        error: `status must be one of: ${LegacyService.EXECUTION_STATUSES.join(", ")}`
      });
    }
    const executionIds = await this.resolveBulkExecutions(cycleId, body);
    for (const executionId of executionIds) {
      await this.updateExecution(executionId, uid, { status });
    }
    return { updated: executionIds.length, status };
  }

  /**
   * Assigns a selection of a run's executions to one person.
   *
   * Also previously an empty method. The assignee has to be a member of the run's project: work
   * assigned to someone who cannot open the project is an execution nobody can action.
   */
  async bulkAssignExecutions(cycleId: string, userId: string | null | undefined, body: Body) {
    const uid = this.requireUser(userId);
    const projectId = await this.requireCycleAccess(uid, cycleId);
    const assigneeId = body.assigneeId === null || body.assigneeId === undefined ? null : String(body.assigneeId);
    if (assigneeId !== null) {
      if (!isUuid(assigneeId)) throw new NotFoundException({ error: "Assignee not found" });
      const member = await this.db.query(
        "SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2",
        [projectId, assigneeId]
      );
      if (!member.rows[0]) {
        throw new BadRequestException({ error: "The assignee must be a member of this project" });
      }
    }
    const executionIds = await this.resolveBulkExecutions(cycleId, body);
    for (const executionId of executionIds) {
      await this.updateExecution(executionId, uid, { assigneeId });
    }
    return { updated: executionIds.length, assigneeId };
  }

  /**
   * The rows behind GET /api/cycles/:cycleId/export/csv, resolved through the run's project.
   *
   * The export used to take no caller at all: a whole run — case titles, external ids, actual
   * results and the linked defect keys and URLs — came back to anyone holding a cycle id, with no
   * session and from any workspace. It also answered a malformed id with a 500 (the uuid cast) and a
   * well-formed unknown one with a header-only CSV, so a mistyped id downloaded an empty "report"
   * instead of saying the run wasn't there.
   *
   * Note the rest of /api/cycles/* still has the original gap — executions(), getCycle(),
   * updateCycle(), deleteCycle() and the cycle_items routes take no @Req() either, so these same
   * rows remain readable through GET /api/cycles/:cycleId/executions. Closing that is a change
   * across all of those handlers, not this one.
   */
  async exportCycleExecutions(userId: string | null | undefined, cycleId: string) {
    const uid = this.requireUser(userId);
    // Same answer for a malformed id as for one that doesn't exist — see requireProjectAccess.
    if (!isUuid(cycleId)) throw new NotFoundException({ error: "Cycle not found" });
    const cycle = await this.db.query<{ project_id: string }>("SELECT project_id FROM cycles WHERE id = $1", [cycleId]);
    if (!cycle.rows[0]) throw new NotFoundException({ error: "Cycle not found" });
    await this.requireProjectAccess(uid, cycle.rows[0].project_id);
    return this.executions(cycleId);
  }

  async updateExecution(executionId: string, actorId: string | null | undefined, body: Body) {
    const uid = this.requireUser(actorId);
    /*
     * Basecamp 10189985971 (automation ingest scoping) surfaced this as a pre-existing defect.
     *
     * EXECUTION_STATUSES was checked in bulkUpdateExecutionStatus and NOT here — yet this is the
     * single-result path, taken by PATCH /api/cycles/:cycleId/executions/:executionId, by the MCP
     * `record_execution_result` tool, and (now) by the automation ingest. `status` is
     * VARCHAR(32), so before this check:
     *
     *   - {"status": "pass"} stored the literal string `pass`. Every aggregate in the product
     *     counts by exact match ('Passed', 'Failed', ...), so the case showed as neither passed
     *     nor executed while displaying a status. Silent corruption, no error, and the card's own
     *     draft contract in §6 specifies exactly that lowercase vocabulary.
     *   - a 33-character status reached Postgres and failed the length constraint, turning user
     *     input into an unhandled 500.
     *
     * The empty string is left alone: `body.status || null` below treats it as "not supplied",
     * which is how a PATCH that only changes the assignee arrives.
     */
    if (body.status !== undefined && body.status !== null && body.status !== "") {
      const status = String(body.status);
      if (!LegacyService.EXECUTION_STATUSES.includes(status)) {
        throw new BadRequestException({
          error: `status must be one of: ${LegacyService.EXECUTION_STATUSES.join(", ")}`
        });
      }
    }
    const before = await this.db.query(
      `SELECT e.*, c.project_id, COALESCE(NULLIF(ci.snapshot_title, ''), NULLIF(t.title, ''), 'Untitled test case') AS testcase_title
       FROM executions e
       JOIN cycle_items ci ON ci.id = e.cycle_item_id
       JOIN cycles c ON c.id = ci.cycle_id
       LEFT JOIN testcases t ON t.id = ci.testcase_id
       WHERE e.id = $1 AND e.deleted_at IS NULL`,
      [executionId]
    );
    if (!before.rows[0]) throw new NotFoundException({ error: "Execution not found" });
    // The execution was resolved but its project never was: a signed-in caller from any workspace
    // could rewrite another team's result by execution id.
    await this.requireProjectAccess(uid, before.rows[0].project_id);
    /*
     * Basecamp 10221790207 ("[Test Run] Only failed test case should show defect key and Defect
     * URL"). The two fields were offered on every status, so a passing test could carry a defect
     * reference — which then travels into the CSV export and the traceability matrix, where it reads
     * as "this passing case has a bug against it".
     *
     * The screens now only show the inputs on Failed. This clears the stored values when a status
     * other than Failed is recorded, because hiding them alone would leave the stale reference in
     * the database and in every export that reads it. A defect on a case that is no longer failing
     * is not data worth keeping — the bug itself, and its link, are what survive.
     */
    const clearsDefect = typeof body.status === "string" && body.status !== "" && body.status !== "Failed";
    /*
     * "[Test Runs] Unable to assign test cases for execution": assignee_id used to be written
     * unconditionally as `body.assigneeId ?? null`, so any PATCH that didn't mention it — every
     * status-change and every quick-view Save — silently wiped whatever assignee bulkAssignExecutions
     * had just set. Same explicit-clear convention as clearsDefect/clearsPriority: key absent leaves
     * the column alone (COALESCE), key sent as null/"" clears it on purpose.
     */
    const clearsAssignee = body.assigneeId === null || body.assigneeId === "";
    let assigneeId: string | null = null;
    if (body.assigneeId !== undefined && body.assigneeId !== null && body.assigneeId !== "") {
      assigneeId = String(body.assigneeId);
      if (!isUuid(assigneeId)) throw new NotFoundException({ error: "Assignee not found" });
      const member = await this.db.query(
        "SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2",
        [before.rows[0].project_id, assigneeId]
      );
      if (!member.rows[0]) {
        throw new BadRequestException({ error: "The assignee must be a member of this project" });
      }
    }
    const res = await this.db.query(
      `UPDATE executions SET status=COALESCE($2,status),
       assignee_id=CASE WHEN $9::boolean THEN NULL ELSE COALESCE($3,assignee_id) END,
       actual_result=COALESCE($4,actual_result),
       executed_at=CASE WHEN $2 IS NULL THEN executed_at ELSE now() END,
       defect_key=CASE WHEN $8::boolean THEN NULL ELSE COALESCE($5,defect_key) END,
       defect_url=CASE WHEN $8::boolean THEN NULL ELSE COALESCE($6,defect_url) END,
       executed_by=$7, updated_at=now()
       WHERE id=$1 AND deleted_at IS NULL
       RETURNING *`,
      [
        executionId,
        body.status || null,
        assigneeId,
        body.actualResult || null,
        body.defectKey || null,
        body.defectUrl || null,
        uid,
        clearsDefect,
        clearsAssignee
      ]
    );
    await this.logProjectActivity(
      before.rows[0].project_id,
      uid,
      "execution_updated",
      "execution",
      executionId,
      before.rows[0].testcase_title,
      { before: toCamel(before.rows[0]), after: toCamel(res.rows[0]) }
    );
  }

  private bugSelect(where: string): string {
    return `
      SELECT b.*, COALESCE(u.name, u.email) AS reporter_name, u.email AS reporter_email,
             COALESCE(ap.display_name, ap.email) AS assignee_name, ap.actor_type AS assignee_type, links.items AS links,
             COALESCE(atts.items, '[]') AS attachments
      FROM bugs b
      LEFT JOIN users u ON u.id = b.reported_by
      LEFT JOIN actor_profiles ap ON ap.id = b.assignee_id
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object(
          'id', bl.id,
          'testcaseId', bl.testcase_id,
          'testcaseTitle', t.title,
          'testcaseExternalId', t.external_id,
          'cycleId', bl.cycle_id,
          'cycleName', c.name,
          'executionId', bl.execution_id
        ) ORDER BY bl.created_at) AS items
        FROM bug_links bl
        LEFT JOIN testcases t ON t.id = bl.testcase_id
        LEFT JOIN cycles c ON c.id = bl.cycle_id
        WHERE bl.bug_id = b.id
      ) links ON true
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object(
          'id', a.id,
          'fileName', a.file_name,
          'contentType', a.content_type,
          'fileSize', a.file_size,
          'createdAt', a.created_at
        ) ORDER BY a.created_at) AS items
        FROM attachments a
        WHERE a.entity_type = 'bug' AND a.entity_id = b.id
      ) atts ON true
      WHERE ${where}`;
  }

  /**
   * Resolves a bug and confirms the caller may reach the project it belongs to.
   *
   * /api/bugs/:bugId is addressed by bug id with no project in the URL. Read, update, delete and both
   * link routes took no caller at all — a bug carries reproduction steps, severity and links to the
   * executions that found it, and PATCH let anyone rewrite someone else's defect report.
   */
  private async requireBugAccess(userId: string | null | undefined, bugId: string): Promise<string> {
    const uid = this.requireUser(userId);
    if (!isUuid(bugId)) throw new NotFoundException({ error: "Bug not found" });
    const res = await this.db.query<{ project_id: string }>("SELECT project_id FROM bugs WHERE id = $1", [bugId]);
    if (!res.rows[0]) throw new NotFoundException({ error: "Bug not found" });
    await this.requireProjectAccess(uid, res.rows[0].project_id);
    return res.rows[0].project_id;
  }

  async listBugsForUser(userId: string | null | undefined, projectId: string, query: Body = {}) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    return this.listBugs(projectId, query);
  }

  async listBugs(projectId: string, query: Body = {}) {
    const filters = ["b.project_id = $1"];
    const values: any[] = [projectId];
    if (query.status) {
      values.push(query.status);
      filters.push(`b.status = $${values.length}`);
    }
    if (query.cycleId) {
      values.push(query.cycleId);
      filters.push(`b.cycle_id = $${values.length}`);
    }
    // "unassigned" is a real, filterable state — not just the absence of a query param — so it gets
    // its own value rather than trying to express IS NULL through an empty/omitted assigneeId.
    if (query.assigneeId === "unassigned") {
      filters.push("b.assignee_id IS NULL");
    } else if (query.assigneeId) {
      values.push(query.assigneeId);
      filters.push(`b.assignee_id = $${values.length}`);
    }
    const res = await this.db.query(`${this.bugSelect(filters.join(" AND "))} ORDER BY b.created_at DESC`, values);
    return res.rows.map((row) => ({
      ...toCamel(row),
      links: normalizeJsonArray(row.links).map(toCamel),
      attachments: normalizeJsonArray(row.attachments).map(toCamel)
    }));
  }

  /*
   * Linking a bug to a test case in a run marks that execution Failed.
   *
   * Basecamp 10226284379 and 10221755377 (the same request from two reporters): a bug was filed
   * against a case in a run and the case sat there Untested, so the run's own numbers said nothing
   * had gone wrong. The run screen already prompts for a bug when you mark something Failed; this is
   * the reverse path — reporting from the Bugs page, or adding a link later — which never touched
   * the execution at all.
   *
   * Decided behaviour: it ALWAYS sets Failed, including over a result someone already recorded. A
   * bug against a case that is currently Passed is precisely the case worth flipping, and a rule
   * with an exception in it ("unless someone passed it") is the kind that quietly does nothing on
   * the day it matters. The previous status is written into the activity payload so the override is
   * visible afterwards rather than silent, and an execution that is already Failed is left alone so
   * re-linking doesn't churn executed_at or spam the activity stream.
   *
   * Scoped by project: a link row can name any execution id, and without the join a caller could
   * flip a result in a workspace they cannot see.
   */
  private async failLinkedExecutions(projectId: string, actorId: string | null | undefined, links: Body[]) {
    const executionIds = [...new Set(links.map((link) => link.executionId).filter((id): id is string => isUuid(String(id ?? ""))))];
    if (executionIds.length === 0) return;

    const affected = await this.db.query(
      `SELECT e.id, e.status, COALESCE(NULLIF(ci.snapshot_title, ''), NULLIF(t.title, ''), 'Untitled test case') AS testcase_title
         FROM executions e
         JOIN cycle_items ci ON ci.id = e.cycle_item_id
         JOIN cycles c ON c.id = ci.cycle_id
         LEFT JOIN testcases t ON t.id = ci.testcase_id
        WHERE e.id = ANY($1::uuid[]) AND e.deleted_at IS NULL AND c.project_id = $2`,
      [executionIds, projectId]
    );

    for (const row of affected.rows) {
      if (row.status === "Failed") continue;
      await this.db.query(
        `UPDATE executions SET status = 'Failed', executed_at = now(), executed_by = $2, updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL`,
        [row.id, actorId || null]
      );
      await this.logProjectActivity(projectId, actorId ?? null, "execution_updated", "execution", String(row.id), row.testcase_title, {
        reason: "bug_linked",
        before: { status: row.status },
        after: { status: "Failed" }
      });
    }
  }

  /*
   * Link targets have to exist in THIS project before they reach an insert.
   *
   * `bugs.execution_id`, `testcase_id` and `cycle_id` are all foreign keys, and the ids arrive in a
   * request body — so a caller naming an execution that does not exist (a stale tab, a copied id, a
   * CI script with the wrong run) produced a 23503 foreign-key violation, which surfaces as a 500.
   * Found by the regression test written for the auto-fail change: "a bogus execution id in the
   * links is ignored rather than 500ing" was asserting the behaviour this now has.
   *
   * Unresolvable ids are dropped rather than rejected: a bug report is worth keeping even when one
   * of its links is stale, and the link rows are a convenience, not the record. A link with nothing
   * left to point at is dropped entirely.
   */
  private async sanitizeBugLinks(projectId: string, links: Body[]): Promise<Body[]> {
    if (!links.length) return links;
    const ids = (key: string) => [...new Set(links.map((l) => String(l?.[key] ?? "")).filter((v) => isUuid(v)))];
    const [testcaseIds, cycleIds, executionIds] = [ids("testcaseId"), ids("cycleId"), ids("executionId")];

    const resolved = async (sql: string, candidates: string[]): Promise<Set<string>> => {
      if (!candidates.length) return new Set();
      const res = await this.db.query<{ id: string }>(sql, [candidates, projectId]);
      return new Set(res.rows.map((row) => String(row.id)));
    };
    const [validTestcases, validCycles, validExecutions] = await Promise.all([
      resolved("SELECT id FROM testcases WHERE id = ANY($1::uuid[]) AND project_id = $2 AND deleted_at IS NULL", testcaseIds),
      resolved("SELECT id FROM cycles WHERE id = ANY($1::uuid[]) AND project_id = $2", cycleIds),
      resolved(
        `SELECT e.id FROM executions e
           JOIN cycle_items ci ON ci.id = e.cycle_item_id
           JOIN cycles c ON c.id = ci.cycle_id
          WHERE e.id = ANY($1::uuid[]) AND c.project_id = $2 AND e.deleted_at IS NULL`,
        executionIds
      )
    ]);

    const keep = (value: unknown, valid: Set<string>) => (valid.has(String(value ?? "")) ? String(value) : null);
    return links
      .map((link) => ({
        ...link,
        testcaseId: keep(link?.testcaseId, validTestcases),
        cycleId: keep(link?.cycleId, validCycles),
        executionId: keep(link?.executionId, validExecutions)
      }))
      .filter((link) => link.testcaseId || link.cycleId || link.executionId);
  }

  private async replaceBugLinks(client: PoolClient, bugId: string, links: Body[]) {
    await client.query("DELETE FROM bug_links WHERE bug_id = $1", [bugId]);
    for (const link of links) {
      await client.query(
        `INSERT INTO bug_links (bug_id, testcase_id, cycle_id, execution_id) VALUES ($1,$2,$3,$4)
         ON CONFLICT (bug_id, testcase_id, cycle_id) DO NOTHING`,
        [bugId, link.testcaseId || null, link.cycleId || null, link.executionId || null]
      );
    }
  }

  /**
   * The severity a caller asked for, refused as caller error when it isn't one we have.
   *
   * V67's bugs_severity_check already stops an unknown value reaching the column, but a raw
   * constraint violation surfaces as a 500 naming nothing. These are exactly the four buckets the
   * project dashboard's bySeverity reports, so a fifth would also be counted by the bugs list and
   * dropped by the dashboard.
   */
  private parseBugPriority(priority: unknown): "P0" | "P1" | "P2" | "P3" | null {
    // Absent, null and "" all mean "untriaged" rather than an error — the field is optional on both
    // create and edit, and the UI's empty option submits "".
    if (priority === undefined || priority === null || priority === "") return null;
    const match = BUG_PRIORITIES.find((p) => p.toLowerCase() === String(priority).trim().toLowerCase());
    if (!match)
      throw new BadRequestException({
        error: `priority must be one of ${BUG_PRIORITIES.join(", ")}`,
        field: "priority"
      });
    return match;
  }

  private parseBugSeverity(severity: unknown): "Critical" | "High" | "Medium" | "Low" {
    if (severity === undefined || severity === null || severity === "") return "Medium";
    const match = BUG_SEVERITIES.find((s) => s.toLowerCase() === String(severity).trim().toLowerCase());
    if (!match)
      throw new BadRequestException({
        error: `severity must be one of ${BUG_SEVERITIES.join(", ")}`,
        field: "severity"
      });
    return match;
  }

  /**
   * The assignee a caller asked for, refused as caller error when they aren't a member of this
   * project. Mirrors bulkAssignExecutions' membership check so bugs and executions share one rule:
   * work assigned to someone who cannot open the project is work nobody can action, and it also
   * closes the cross-tenant case — a real user id from a different project fails the same way as
   * one that doesn't exist.
   */
  private async parseBugAssignee(projectId: string, assigneeId: unknown): Promise<string | null> {
    if (assigneeId === undefined || assigneeId === null || assigneeId === "") return null;
    const id = String(assigneeId);
    if (!isUuid(id)) throw new NotFoundException({ error: "Assignee not found" });
    const member = await this.db.query("SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2", [projectId, id]);
    if (!member.rows[0]) throw new BadRequestException({ error: "The assignee must be a member of this project" });
    return id;
  }

  async createBug(projectId: string, userId: string | null | undefined, body: Body) {
    // A link is required whenever the project actually has test cases/runs to link to — enforced
    // client-side (the UI only lets the field be empty when there's nothing to pick). An empty
    // array is accepted here so reporting a bug is never blocked in a project with no test runs yet.
    validateBoundedField(body.title, "Bug title", BUG_TITLE_MAX_LENGTH);
    validateBoundedField(body.externalUrl, "External URL", BUG_EXTERNAL_URL_MAX_LENGTH);
    const links = await this.sanitizeBugLinks(projectId, normalizeJsonArray(body.links));
    const severity = this.parseBugSeverity(body.severity);
    const priority = this.parseBugPriority(body.priority);
    const assigneeId = await this.parseBugAssignee(projectId, body.assigneeId);

    const bugId = await this.db.transaction(async (client) => {
      const res = await client.query(
        `INSERT INTO bugs (project_id, execution_id, testcase_id, cycle_id, title, description, external_url, status, severity, priority, reported_by, integration_provider, integration_issue_key, betterbugs_url, assignee_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [
          projectId,
          links[0]?.executionId || null,
          links[0]?.testcaseId || null,
          links[0]?.cycleId || null,
          body.title || "Untitled bug",
          body.description || "",
          body.externalUrl || null,
          body.status || "Open",
          severity,
          priority,
          userId || null,
          body.integrationProvider || null,
          body.integrationIssueKey || null,
          body.betterbugsUrl || null,
          assigneeId
        ]
      );
      const id = res.rows[0].id;
      await this.replaceBugLinks(client, id, links);
      return id;
    });
    // After the commit, not inside it: the bug is the record that must exist, and a failure while
    // flipping an execution should not roll back the bug report someone just wrote.
    await this.failLinkedExecutions(projectId, userId, links);
    return this.getBug(bugId);
  }

  async getBugForUser(userId: string | null | undefined, bugId: string) {
    await this.requireBugAccess(userId, bugId);
    return this.getBug(bugId);
  }

  /**
   * One bug by id, without a caller check.
   *
   * Kept unguarded for the four callers that re-read a row they have just written through an
   * already-authorized path (create, update, add link, remove link). Route traffic goes through
   * getBugForUser.
   */
  async getBug(bugId: string) {
    const res = await this.db.query(this.bugSelect("b.id = $1"), [bugId]);
    if (!res.rows[0]) throw new NotFoundException({ error: "Bug not found" });
    const row = res.rows[0];
    return { ...toCamel(row), links: normalizeJsonArray(row.links).map(toCamel), attachments: normalizeJsonArray(row.attachments).map(toCamel) };
  }

  async updateBug(userId: string | null | undefined, bugId: string, body: Body) {
    const projectId = await this.requireBugAccess(userId, bugId);
    // Same refusal as createBug — an unknown severity on edit hit the same constraint and the same
    // opaque 500. Absent/empty leaves the stored value alone via COALESCE, so it isn't parsed.
    if (body.severity) this.parseBugSeverity(body.severity);
    validateBoundedField(body.title, "Bug title", BUG_TITLE_MAX_LENGTH);
    validateBoundedField(body.externalUrl, "External URL", BUG_EXTERNAL_URL_MAX_LENGTH);
    /*
     * Priority is the one field here that can be cleared. COALESCE means "absent leaves it alone",
     * which is right for every other column, but an explicitly sent null has to be able to take a
     * bug back to untriaged — so it gets its own flag rather than another COALESCE.
     */
    const clearsPriority = body.priority === null || body.priority === "";
    const priority = this.parseBugPriority(body.priority);
    // Same explicit-clear convention as priority, and the same membership check as createBug/
    // updateExecution — an assignee who isn't a member of this bug's project is refused, not just
    // hidden from the picker.
    const clearsAssignee = body.assigneeId === null || body.assigneeId === "";
    const assigneeId = await this.parseBugAssignee(projectId, body.assigneeId);
    await this.db.query(
      `UPDATE bugs SET title=COALESCE($2,title), description=COALESCE($3,description), external_url=COALESCE($4,external_url),
       status=COALESCE($5,status), severity=COALESCE($6,severity), priority=CASE WHEN $10::boolean THEN NULL ELSE COALESCE($11,priority) END,
       integration_provider=COALESCE($7,integration_provider), integration_issue_key=COALESCE($8,integration_issue_key),
       betterbugs_url=COALESCE($9,betterbugs_url),
       assignee_id=CASE WHEN $12::boolean THEN NULL ELSE COALESCE($13,assignee_id) END,
       updated_at=now() WHERE id=$1`,
      [
        bugId,
        body.title || null,
        body.description || null,
        body.externalUrl || null,
        body.status || null,
        body.severity || null,
        body.integrationProvider || null,
        body.integrationIssueKey || null,
        body.betterbugsUrl || null,
        clearsPriority,
        priority,
        clearsAssignee,
        assigneeId
      ]
    );
    if (Array.isArray(body.links)) {
      const owner = await this.db.query<{ project_id: string }>("SELECT project_id FROM bugs WHERE id = $1", [bugId]);
      const sanitized = await this.sanitizeBugLinks(String(owner.rows[0]?.project_id ?? ""), normalizeJsonArray(body.links));
      await this.db.transaction((client) => this.replaceBugLinks(client, bugId, sanitized));
    }
    return this.getBug(bugId);
  }

  async addBugLink(userId: string | null | undefined, bugId: string, body: Body) {
    await this.requireBugAccess(userId, bugId);
    if (!body.testcaseId && !body.cycleId) throw new BadRequestException({ error: "testcaseId or cycleId is required." });
    await this.db.query(
      `INSERT INTO bug_links (bug_id, testcase_id, cycle_id, execution_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (bug_id, testcase_id, cycle_id) DO NOTHING`,
      [bugId, body.testcaseId || null, body.cycleId || null, body.executionId || null]
    );
    // requireBugAccess already resolved this bug's project; re-read it rather than trusting the
    // caller's body, which never carries a project id.
    const owner = await this.db.query<{ project_id: string }>("SELECT project_id FROM bugs WHERE id = $1", [bugId]);
    const projectId = owner.rows[0]?.project_id;
    if (projectId) await this.failLinkedExecutions(String(projectId), userId, [body]);
    return this.getBug(bugId);
  }

  async removeBugLink(userId: string | null | undefined, bugId: string, linkId: string) {
    await this.requireBugAccess(userId, bugId);
    await this.db.query("DELETE FROM bug_links WHERE id = $1 AND bug_id = $2", [linkId, bugId]);
    return this.getBug(bugId);
  }

  async deleteBug(userId: string | null | undefined, bugId: string) {
    await this.requireBugAccess(userId, bugId);
    await this.db.query("DELETE FROM bugs WHERE id = $1", [bugId]);
  }

  // The client controls the uploaded filename completely, and it is only ever a display label —
  // the storage key is built from ids plus a fresh uuid, taking nothing but the extension. So the
  // name is normalised rather than trusted: directory components are stripped (a screenshot named
  // `../../etc/passwd` is just `passwd`), control characters are dropped so they can't be smuggled
  // into a Content-Disposition header, and the result is cut to fit file_name's varchar(255).
  // Without that last step a long-but-legitimate name (240 chars is well inside the filesystem's
  // own ceiling) makes Postgres reject the insert and the whole upload answers with a 500.
  // Public rather than private only so the automation ingest can sanitise the file names a CI
  // process supplies with the same rules the human upload paths use; duplicating it would let the
  // two drift.
  static displayFileName(originalName: string, max = 255): string {
    const base = path
      .basename(String(originalName ?? "").replace(/\\/g, "/"))
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim();
    if (!base || base === "." || base === "..") return "upload";
    if (base.length <= max) return base;
    // Keep the extension attached to the truncated stem — it is what tells the browser and the
    // person downloading it what the file actually is.
    const ext = path.extname(base);
    return ext.length > 0 && ext.length < max ? `${base.slice(0, max - ext.length)}${ext}` : base.slice(0, max);
  }

  /*
   * Evidence uploads — bug attachments and execution attachments — validate what they accept.
   *
   * Basecamp 10226296533 ("[Bug Attachments] Missing File Type and Size Validations Cause Upload to
   * Get Stuck on Saving"): nothing here checked type or size. Every extension was accepted, and the
   * only ceiling was the interceptor's MAX_UPLOAD_SIZE — the 100MB the knowledge base uses — which
   * multer enforces mid-stream, so the caller got a failure with no field-level reason and the modal
   * simply sat there. Both gaps are one function now, and both evidence routes call it, because
   * uploadExecutionAttachments had exactly the same hole.
   *
   * The allowlist is deliberately the knowledge base's: it already excludes zip and exe on purpose
   * (a zip hides anything past an extension check) and evidence has no reason to accept more than a
   * knowledge base document does.
   *
   * The size cap is its own, lower value. Evidence is screenshots, logs and short clips; a
   * full-length recording belongs in the BetterBugs session a bug can already link to, not in a
   * 100MB upload billed against the workspace's storage allowance. MAX_EVIDENCE_FILE_SIZE overrides
   * it without a code change.
   */
  static readonly EVIDENCE_MAX_FILE_SIZE = Number(process.env.MAX_EVIDENCE_FILE_SIZE) || 25 * 1024 * 1024;

  private static formatFileSize(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  }

  /*
   * Validates the whole batch before a single byte is stored: the upload loops over the files
   * calling storage.put per file, so rejecting halfway would leave the accepted ones written and
   * billed while the request answers 400. All-or-nothing is the only defensible outcome.
   */
  private static assertValidEvidenceFiles(files: Array<{ originalname: string; size: number }>) {
    const supported = [...LegacyService.KB_ALLOWED_EXTENSIONS].sort().join(", ");
    for (const file of files) {
      const name = LegacyService.displayFileName(file.originalname);
      const ext = path.extname(file.originalname).replace(/^\./, "").toLowerCase();
      if (!ext) {
        throw new BadRequestException({
          error: `${name} has no file extension, so its type can't be determined. Supported types: ${supported}.`
        });
      }
      if (!LegacyService.KB_ALLOWED_EXTENSIONS.has(ext)) {
        throw new BadRequestException({ error: `${name}: .${ext} files aren't supported. Supported types: ${supported}.` });
      }
      // A zero-byte file is almost always a failed drag-and-drop or a still-being-written file, and
      // it stores nothing useful while still consuming an attachment row and a storage key.
      if (file.size <= 0) throw new BadRequestException({ error: `${name} is empty (0 bytes).` });
      if (file.size > LegacyService.EVIDENCE_MAX_FILE_SIZE) {
        throw new BadRequestException({
          error:
            `${name} is ${LegacyService.formatFileSize(file.size)}, which is over the ` +
            `${LegacyService.formatFileSize(LegacyService.EVIDENCE_MAX_FILE_SIZE)} limit for evidence files.`
        });
      }
    }
  }

  // Bug evidence uploads — reuses the generic `attachments` table (entity_type='bug') rather
  // than a dedicated table, since it already models exactly this (project-scoped file metadata
  // pointing at a storage key), and nothing else in the app used it yet.
  async uploadBugAttachments(
    projectId: string,
    userId: string | null | undefined,
    bugId: string,
    files: Array<{ buffer: Buffer; originalname: string; mimetype: string; size: number }>
  ) {
    // Uploading writes a file into the workspace's storage and bills it to that workspace's plan
    // allowance, so it needs a caller who is a member of this project — existence of the bug row
    // is not authorization.
    const uid = this.requireUser(userId);
    const project = await this.requireProjectAccess(uid, projectId);
    if (!files || files.length === 0) throw new BadRequestException({ error: "No files were uploaded" });
    if (!isUuid(bugId)) throw new NotFoundException({ error: "Bug not found" });
    const bug = await this.db.query("SELECT b.id FROM bugs b WHERE b.id = $1 AND b.project_id = $2", [bugId, projectId]);
    if (!bug.rows[0]) throw new NotFoundException({ error: "Bug not found" });
    LegacyService.assertValidEvidenceFiles(files);
    await this.planLimits.assertStorageAvailable(
      project.organization_id,
      files.reduce((sum, file) => sum + file.size, 0)
    );

    const created: Body[] = [];
    for (const file of files) {
      const ext = path.extname(file.originalname).replace(/^\./, "").toLowerCase();
      const storageKey = `bugs/${projectId}/${bugId}/${randomUUID()}${ext ? `.${ext}` : ""}`;
      await this.storage.put(storageKey, file.buffer, file.mimetype);
      const res = await this.db.query(
        `INSERT INTO attachments (project_id, entity_type, entity_id, file_name, content_type, file_size, storage_path, uploaded_by)
         VALUES ($1, 'bug', $2, $3, $4, $5, $6, $7) RETURNING *`,
        [projectId, bugId, LegacyService.displayFileName(file.originalname), file.mimetype, file.size, storageKey, uid]
      );
      created.push(toCamel(res.rows[0]));
    }
    return { list: created, total: created.length };
  }

  // `scopeProjectId` keeps a lookup by attachment id from crossing into another project's
  // evidence: the caller has already been authorized for that project, so the row has to
  // belong to it too or it simply isn't found.
  private async bugAttachment(attachmentId: string, scopeProjectId?: string): Promise<Body> {
    if (!isUuid(attachmentId)) throw new NotFoundException({ error: "Attachment not found" });
    const res = await this.db.query(
      `SELECT * FROM attachments WHERE id = $1 AND entity_type = 'bug'
       AND ($2::uuid IS NULL OR project_id = $2::uuid)`,
      [attachmentId, scopeProjectId ?? null]
    );
    if (!res.rows[0]) throw new NotFoundException({ error: "Attachment not found" });
    return res.rows[0];
  }

  async getBugAttachmentAccess(projectId: string, userId: string | null | undefined, attachmentId: string, inline: boolean) {
    // Bug evidence is confidential: an attachment id turning up in a link, a log line or an
    // exported report must not be enough to hand the file to whoever holds it.
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const file = await this.bugAttachment(attachmentId, projectId);
    if (!file.storage_path || !(await this.storage.exists(file.storage_path))) {
      throw new NotFoundException({ error: "File content is not available" });
    }
    const mimeType = file.content_type || "application/octet-stream";
    const access = await this.storage.getAccessUrl(file.storage_path, { filename: file.file_name, inline, contentType: mimeType });
    return { ...access, mimeType, originalFileName: file.file_name };
  }

  async deleteBugAttachment(attachmentId: string, userId?: string | null) {
    // This route carries no project id, so the attachment's own project is what the caller is
    // authorized against. It destroys the stored object as well as the row — an unauthorized
    // caller here doesn't just read someone's evidence, they lose it for them.
    const uid = this.requireUser(userId);
    const file = await this.bugAttachment(attachmentId);
    await this.requireProjectAccess(uid, String(file.project_id));
    await this.storage.delete(file.storage_path);
    await this.db.query("DELETE FROM attachments WHERE id = $1", [attachmentId]);
    return { ok: true };
  }

  // Execution evidence uploads — same generic `attachments` table as bug evidence
  // (entity_type='execution'), mirroring uploadBugAttachments. The execution routes are
  // nested under /api/cycles/:cycleId/executions/:executionId (no projectId in the path),
  // so the project is resolved via the cycle/cycle_item join instead of being passed in.
  // Resolves the project (and org) that owns an execution, which is what both execution
  // attachment routes authorize against — neither carries a projectId in its path. A malformed
  // id is answered the same way as a well-formed one that doesn't exist, rather than being handed
  // to Postgres to fail the uuid cast and turn a typo into a 500.
  private async executionOwner(cycleId: string, executionId: string): Promise<Body> {
    if (!isUuid(cycleId) || !isUuid(executionId)) throw new NotFoundException({ error: "Execution not found" });
    const res = await this.db.query(
      `SELECT e.id, c.project_id, p.organization_id FROM executions e
       JOIN cycle_items ci ON ci.id = e.cycle_item_id
       JOIN cycles c ON c.id = ci.cycle_id
       JOIN projects p ON p.id = c.project_id
       WHERE e.id = $1 AND c.id = $2 AND e.deleted_at IS NULL`,
      [executionId, cycleId]
    );
    if (!res.rows[0]) throw new NotFoundException({ error: "Execution not found" });
    return res.rows[0];
  }

  async uploadExecutionAttachments(
    cycleId: string,
    actorId: string | null | undefined,
    executionId: string,
    files: Array<{ buffer: Buffer; originalname: string; mimetype: string; size: number }>
  ) {
    const uid = this.requireUser(actorId);
    if (!files || files.length === 0) throw new BadRequestException({ error: "No files were uploaded" });
    const execution = await this.executionOwner(cycleId, executionId);
    const projectId = String(execution.project_id);
    // Being signed in to the workspace isn't enough: attaching evidence to a run means writing
    // into that project, so the caller has to be a member of it.
    await this.requireProjectAccess(uid, projectId);
    LegacyService.assertValidEvidenceFiles(files);
    await this.planLimits.assertStorageAvailable(
      execution.organization_id,
      files.reduce((sum, file) => sum + file.size, 0)
    );

    const created: Body[] = [];
    for (const file of files) {
      const ext = path.extname(file.originalname).replace(/^\./, "").toLowerCase();
      const storageKey = `executions/${projectId}/${executionId}/${randomUUID()}${ext ? `.${ext}` : ""}`;
      await this.storage.put(storageKey, file.buffer, file.mimetype);
      const res = await this.db.query(
        `INSERT INTO attachments (project_id, entity_type, entity_id, file_name, content_type, file_size, storage_path, uploaded_by)
         VALUES ($1, 'execution', $2, $3, $4, $5, $6, $7) RETURNING *`,
        [projectId, executionId, LegacyService.displayFileName(file.originalname), file.mimetype, file.size, storageKey, uid]
      );
      created.push(toCamel(res.rows[0]));
    }
    await this.logProjectActivity(projectId, uid, "execution_evidence_uploaded", "execution", executionId, null, {
      files: created.map((file) => ({ id: file.id, fileName: file.fileName }))
    });
    return { list: created, total: created.length };
  }

  /**
   * Serves one execution evidence file.
   *
   * This route did not exist. `uploadExecutionAttachments` and `listExecutionAttachments` have both
   * been in the product since the bug-evidence work, so evidence could be stored (and billed
   * against the workspace's storage allowance) and its metadata listed -- with no way to fetch a
   * single byte of it back. Nothing in the frontend called either endpoint, so nothing surfaced
   * the gap; the automation ingest (Basecamp 10189985971 §5) is what makes it load-bearing, since
   * a screenshot or trace nobody can open is not evidence.
   *
   * Mirrors getBugAttachmentAccess, and for the same reason: an attachment id turning up in a log
   * line or an exported report must not be enough to hand the file to whoever holds it, so the
   * caller is authorized against the project that owns the run -- and `scopeExecutionId` keeps a
   * lookup by attachment id from crossing to another execution's evidence even within it.
   */
  async getExecutionAttachmentAccess(
    cycleId: string,
    userId: string | null | undefined,
    executionId: string,
    attachmentId: string,
    inline: boolean
  ) {
    const uid = this.requireUser(userId);
    const execution = await this.executionOwner(cycleId, executionId);
    await this.requireProjectAccess(uid, String(execution.project_id));
    if (!isUuid(attachmentId)) throw new NotFoundException({ error: "Attachment not found" });
    const res = await this.db.query(
      `SELECT * FROM attachments
        WHERE id = $1 AND entity_type = 'execution' AND entity_id = $2 AND project_id = $3`,
      [attachmentId, executionId, execution.project_id]
    );
    const file = res.rows[0];
    if (!file) throw new NotFoundException({ error: "Attachment not found" });
    if (!file.storage_path || !(await this.storage.exists(file.storage_path))) {
      throw new NotFoundException({ error: "File content is not available" });
    }
    const mimeType = file.content_type || "application/octet-stream";
    /*
     * A Playwright trace is a .zip that the ingest accepts as an exception to the evidence
     * allowlist (see automation.types.ts). It is never served inline: `inline` is forced off for
     * anything that is not an image or a video, so a stored archive or log cannot be rendered by a
     * browser in Tesbo's own origin.
     */
    const safeInline = inline && /^(image|video)\//.test(mimeType);
    const access = await this.storage.getAccessUrl(file.storage_path, {
      filename: file.file_name,
      inline: safeInline,
      contentType: mimeType
    });
    return { ...access, mimeType, originalFileName: file.file_name, inline: safeInline };
  }

  /**
   * True for a Playwright trace archive.
   *
   * Checked at both ends of the trace link — when one is minted and again when it is redeemed —
   * because it is the whole reason the public route is safe. Evidence is attacker-supplied content;
   * a zip cannot be rendered as markup by a browser, so serving one from a URL that carries no
   * session cannot become the stored-XSS hole that inline .html evidence would be.
   */
  private static isTraceArchive(file: Body): boolean {
    if (file?.evidence_kind === "trace") return true;
    const type = String(file?.content_type || "").toLowerCase();
    if (type === "application/zip" || type === "application/x-zip-compressed") return true;
    return String(file?.file_name || "").toLowerCase().endsWith(".zip");
  }

  /**
   * Mints a short-lived link to one trace, for the embedded Playwright trace viewer.
   *
   * Authorization happens here and only here: same project-membership check the download route
   * makes, and the same scoping of an attachment id to its own execution, so a token can never be
   * minted for evidence the caller could not already download.
   */
  async createExecutionTraceLink(
    cycleId: string,
    userId: string | null | undefined,
    executionId: string,
    attachmentId: string
  ) {
    const uid = this.requireUser(userId);
    const execution = await this.executionOwner(cycleId, executionId);
    await this.requireProjectAccess(uid, String(execution.project_id));
    if (!isUuid(attachmentId)) throw new NotFoundException({ error: "Attachment not found" });
    const res = await this.db.query(
      `SELECT id, file_name, content_type, evidence_kind, storage_path FROM attachments
        WHERE id = $1 AND entity_type = 'execution' AND entity_id = $2 AND project_id = $3`,
      [attachmentId, executionId, execution.project_id]
    );
    const file = res.rows[0];
    if (!file) throw new NotFoundException({ error: "Attachment not found" });
    // A pointed message rather than a bare 404: asking for a trace link for a screenshot is a
    // caller bug, and one that would otherwise look like the file had gone missing.
    if (!LegacyService.isTraceArchive(file)) {
      throw new BadRequestException({ error: "This attachment is not a Playwright trace" });
    }
    if (!file.storage_path || !(await this.storage.exists(file.storage_path))) {
      throw new NotFoundException({ error: "File content is not available" });
    }
    return {
      token: signTraceLink(String(file.id), executionId),
      expiresAt: new Date(Date.now() + TRACE_LINK_TTL_MS).toISOString()
    };
  }

  /**
   * Redeems a trace link. No session is involved — the signature is the authorization — so every
   * check that matters happened when the token was minted, and the two that still matter here are
   * re-run: the signature (with its TTL) and the file still being a zip.
   */
  async getPublicTraceContent(token: string) {
    const claims = verifyTraceLink(token);
    const res = await this.db.query(
      `SELECT id, file_name, content_type, evidence_kind, storage_path FROM attachments
        WHERE id = $1 AND entity_type = 'execution' AND entity_id = $2`,
      [claims.attachmentId, claims.executionId]
    );
    const file = res.rows[0];
    // Deleted since the link was minted, or never a trace: both answer the same way, since the
    // holder of a bare token is owed no detail about what is on the other side of it.
    if (!file || !LegacyService.isTraceArchive(file)) {
      throw new NotFoundException({ error: "This trace link is no longer valid" });
    }
    if (!file.storage_path || !(await this.storage.exists(file.storage_path))) {
      throw new NotFoundException({ error: "File content is not available" });
    }
    return { buffer: await this.storage.getBuffer(file.storage_path), fileName: String(file.file_name) };
  }

  async listExecutionAttachments(cycleId: string, userId: string | null | undefined, executionId: string) {
    const uid = this.requireUser(userId);
    const execution = await this.executionOwner(cycleId, executionId);
    await this.requireProjectAccess(uid, String(execution.project_id));
    // Columns are listed rather than SELECT *: storage_path is an internal storage key that no
    // client needs and that shouldn't travel out of the backend.
    const res = await this.db.query(
      `SELECT id, project_id, entity_type, entity_id, file_name, content_type, file_size, uploaded_by,
              evidence_kind, created_at
       FROM attachments WHERE entity_type = 'execution' AND entity_id = $1 ORDER BY created_at`,
      [executionId]
    );
    return { list: res.rows.map(toCamel), total: res.rowCount };
  }

  /*
   * The reporting endpoints, gated.
   *
   * Every aggregate below reads real project content — test case titles, bug titles and their
   * external URLs, assignee names, suite names, per-run results — and until these wrappers existed
   * their controller methods took no @Req() at all, so there was nothing to authorize against: any
   * caller who knew (or guessed) a project id could read another workspace's entire reporting
   * surface, with no session of any kind. requireProjectAccess() also rejects a malformed id, which
   * is what stops `/api/projects/not-a-uuid/analytics` answering a typo with a 500 from the failed
   * uuid cast.
   *
   * Reads only — the plan-limit write lock deliberately leaves reports readable on a locked project.
   */
  async projectAnalyticsForUser(userId: string | null | undefined, projectId: string) {
    await this.requireProjectAccess(userId, projectId);
    return this.analytics(projectId);
  }

  async executionReportForUser(userId: string | null | undefined, projectId: string, query: Body) {
    await this.requireProjectAccess(userId, projectId);
    return this.executionReport(projectId, query);
  }

  async requirementMatrixForUser(userId: string | null | undefined, projectId: string) {
    await this.requireProjectAccess(userId, projectId);
    return this.requirementMatrix(projectId);
  }

  async repositorySummaryForUser(userId: string | null | undefined, projectId: string) {
    await this.requireProjectAccess(userId, projectId);
    return this.repositorySummary(projectId);
  }

  async reportsOverviewForUser(userId: string | null | undefined, projectId: string) {
    await this.requireProjectAccess(userId, projectId);
    return this.reportsOverview(projectId);
  }

  async reportsInsightsForUser(userId: string | null | undefined, projectId: string) {
    await this.requireProjectAccess(userId, projectId);
    return this.reportsInsights(projectId);
  }

  async reportsTrendsForUser(userId: string | null | undefined, projectId: string) {
    await this.requireProjectAccess(userId, projectId);
    return this.reportsTrends(projectId);
  }

  async executionReport(projectId: string, query: Body) {
    const filterBy = String(query.filterBy || "overall");
    const filterValue = query.filterValue ? String(query.filterValue) : null;
    const res = await this.db.query(
      `SELECT
         e.id AS execution_id,
         COALESCE(e.status, 'Untested') AS execution_status,
         e.assignee_id,
         ci.testcase_id,
         COALESCE(NULLIF(ci.snapshot_title, ''), NULLIF(t.title, ''), 'Untitled test case') AS testcase_title,
         COALESCE(t.priority, 'Unspecified') AS priority,
         COALESCE(t.automation_tags, '') AS automation_tags,
         t.suite_id,
         COALESCE(s.name, 'No Suite') AS suite_name,
         c.id AS run_id,
         COALESCE(c.name, 'Untitled test run') AS run_name,
         c.plan_id,
         COALESCE(p.name, 'No Plan') AS plan_name,
         COALESCE(u.name, u.email, 'Unassigned') AS assignee_name
       FROM cycles c
       JOIN cycle_items ci ON ci.cycle_id = c.id
       LEFT JOIN executions e ON e.cycle_item_id = ci.id
       LEFT JOIN testcases t ON t.id = ci.testcase_id
       LEFT JOIN suites s ON s.id = t.suite_id
       LEFT JOIN plans p ON p.id = c.plan_id
       LEFT JOIN users u ON u.id = e.assignee_id
       WHERE c.project_id = $1
       ORDER BY c.created_at DESC, ci.position, ci.created_at`,
      [projectId]
    );
    const statusKeys = ["Passed", "Failed", "Blocked", "Skipped", "Untested", "Retest"] as const;
    const groups = new Map<string, Body>();
    const add = (groupId: string, groupName: string, status: string) => {
      const normalizedStatus = statusKeys.includes(status as any) ? status : "Untested";
      const row = groups.get(groupId) || {
        groupId,
        groupName,
        Passed: 0,
        Failed: 0,
        Blocked: 0,
        Skipped: 0,
        Untested: 0,
        Retest: 0,
        total: 0
      };
      row[normalizedStatus] = Number(row[normalizedStatus] || 0) + 1;
      row.total = Number(row.total || 0) + 1;
      groups.set(groupId, row);
    };
    for (const row of res.rows) {
      const tags = String(row.automation_tags || "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
      const matchesFilter = (() => {
        if (!filterValue || filterBy === "overall") return true;
        if (filterBy === "person") return String(row.assignee_id || "unassigned") === filterValue;
        if (filterBy === "plan") return String(row.plan_id || "none") === filterValue;
        if (filterBy === "run") return String(row.run_id) === filterValue;
        if (filterBy === "suite") return String(row.suite_id || "none") === filterValue;
        if (filterBy === "priority") return String(row.priority || "Unspecified") === filterValue;
        if (filterBy === "tags") return tags.includes(filterValue);
        return true;
      })();
      if (!matchesFilter) continue;
      const status = String(row.execution_status || "Untested");
      if (filterBy === "person") add(String(row.assignee_id || "unassigned"), String(row.assignee_name || "Unassigned"), status);
      else if (filterBy === "plan") add(String(row.plan_id || "none"), String(row.plan_name || "No Plan"), status);
      else if (filterBy === "suite") add(String(row.suite_id || "none"), String(row.suite_name || "No Suite"), status);
      else if (filterBy === "priority") add(String(row.priority || "Unspecified"), String(row.priority || "Unspecified"), status);
      else if (filterBy === "tags") {
        const effectiveTags = tags.length ? tags : ["Untagged"];
        for (const tag of effectiveTags) add(tag, tag, status);
      } else {
        add(String(row.run_id), String(row.run_name || "Untitled test run"), status);
      }
    }
    return {
      filterBy,
      filterValue,
      rows: Array.from(groups.values()).sort((a, b) => Number(b.total || 0) - Number(a.total || 0))
    };
  }

  async requirementMatrix(projectId: string) {
    const res = await this.db.query(
      `SELECT
         t.id AS testcase_id,
         COALESCE(t.external_id, '') AS external_id,
         COALESCE(t.title, ci.snapshot_title, 'Untitled test case') AS testcase_title,
         COALESCE(t.priority, '') AS priority,
         COALESCE(t.status, '') AS testcase_status,
         s.name AS suite_name,
         c.id AS run_id,
         c.name AS run_name,
         c.status AS run_status,
         e.id AS execution_id,
         e.status AS execution_status,
         e.executed_at,
         b.id AS bug_id,
         b.title AS bug_title,
         b.status AS bug_status,
         b.external_url AS bug_url
       FROM testcases t
       LEFT JOIN suites s ON s.id = t.suite_id
       LEFT JOIN cycle_items ci ON ci.testcase_id = t.id
       LEFT JOIN cycles c ON c.id = ci.cycle_id
       LEFT JOIN executions e ON e.cycle_item_id = ci.id AND e.deleted_at IS NULL
       LEFT JOIN bugs b ON b.execution_id = e.id
       WHERE t.project_id = $1 AND t.deleted_at IS NULL
       ORDER BY t.external_id, c.created_at DESC NULLS LAST`,
      [projectId]
    );
    return { rows: res.rows.map(toCamel) };
  }

  /*
   * `userId` narrows the workspace-wide scope to the projects that caller is a member of.
   *
   * Basecamp 10199551447 — "[Dashboard / Project Access] QA Engineer can view project details of all
   * owner projects". /api/workspace/analytics scoped by organization_id alone, with no membership
   * filter, so a QA Engineer belonging to ONE project still saw counts and an execution-status
   * breakdown aggregated across every project in the workspace — including the owner's, which they
   * cannot open. listProjects and requireProjectAccess both scope by project_members; this endpoint
   * was the one that did not, and the dashboard is the first screen a member lands on.
   *
   * Applied to every role, privileged ones included, which is the point of Basecamp 10199487634 /
   * 10194293482 ("[Dashboard] Project count displayed incorrectly"): the tile and the Projects page
   * must count the same population, and the page is membership-scoped for everyone. An owner who is
   * not a project_member of some project in their own workspace — the normal state once a manager
   * creates one — otherwise reads a tile the Projects page cannot reproduce. WSA-A-01/WSA-A-02 pin
   * that; RBAC-A-31 pins the QA half.
   */
  async analytics(projectId?: string, organizationId?: string, userId?: string | null) {
    const orgProjectsSubquery =
      "SELECT id FROM projects WHERE organization_id = $1 AND archived_at IS NULL AND id IN (SELECT project_id FROM project_members WHERE user_id = $2)";
    const projectsWhere = projectId
      ? " WHERE id = $1 AND archived_at IS NULL"
      : organizationId
        ? ` WHERE organization_id = $1 AND archived_at IS NULL AND id IN (SELECT project_id FROM project_members WHERE user_id = $2)`
        : " WHERE archived_at IS NULL";
    const childWhere = projectId
      ? " WHERE project_id = $1"
      : organizationId
        ? ` WHERE project_id IN (${orgProjectsSubquery})`
        : "";
    const values = projectId ? [projectId] : organizationId ? [organizationId, userId] : [];
    const [projects, testcases, suites, plans, cycles, statuses] = await Promise.all([
      this.db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM projects${projectsWhere}`, values),
      this.db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM testcases_active${childWhere}`, values),
      this.db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM suites${childWhere}`, values),
      this.db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM plans${childWhere}`, values),
      this.db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM cycles${childWhere}`, values),
      this.db.query<{ status: string; count: string }>(
        `SELECT e.status, COUNT(*) AS count FROM executions_active e JOIN cycle_items ci ON ci.id = e.cycle_item_id JOIN cycles c ON c.id = ci.cycle_id${
          projectId
            ? " WHERE c.project_id = $1"
            : organizationId
              ? ` WHERE c.project_id IN (${orgProjectsSubquery})`
              : ""
        } GROUP BY e.status`,
        values
      )
    ]);
    const executionStatus = Object.fromEntries(statuses.rows.map((r) => [r.status, Number(r.count)]));
    const executionTotal = Object.values(executionStatus).reduce((a: number, b) => a + Number(b), 0);
    return {
      projectCount: Number(projects.rows[0]?.count || 0),
      testCaseCount: Number(testcases.rows[0]?.count || 0),
      suiteCount: Number(suites.rows[0]?.count || 0),
      planCount: Number(plans.rows[0]?.count || 0),
      cycleCount: Number(cycles.rows[0]?.count || 0),
      executionStatus,
      executionTotal
    };
  }

  async repositorySummary(projectId: string) {
    const total = await this.db.query<{ count: string }>("SELECT COUNT(*) AS count FROM testcases_active WHERE project_id = $1", [projectId]);
    const byStatus = await this.groupTestcases(projectId, "status");
    const byPriority = await this.groupTestcases(projectId, "priority");
    const bySuite = await this.db.query<{ name: string; count: string }>(
      `SELECT COALESCE(s.name, 'Unassigned') AS name, COUNT(t.id) AS count
       FROM testcases_active t LEFT JOIN suites s ON s.id = t.suite_id
       WHERE t.project_id = $1 GROUP BY s.name ORDER BY s.name`,
      [projectId]
    );
    const updatedCounts = await this.db.query<{ today: string; this_week: string; this_month: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE updated_at >= now() - interval '1 day')::int AS today,
         COUNT(*) FILTER (WHERE updated_at >= date_trunc('week', now()))::int AS this_week,
         COUNT(*) FILTER (WHERE updated_at >= date_trunc('month', now()))::int AS this_month
       FROM testcases_active WHERE project_id = $1`,
      [projectId]
    );
    const addedByDate = await this.db.query<{ date: string; count: string }>(
      `SELECT to_char(d::date, 'YYYY-MM-DD') AS date, COALESCE(t.cnt, 0)::int AS count
       FROM generate_series((now()::date - interval '29 days'), now()::date, interval '1 day') AS d
       LEFT JOIN (
         SELECT date_trunc('day', created_at) AS day, COUNT(*) AS cnt
         FROM testcases_active WHERE project_id = $1 AND created_at >= now() - interval '30 days'
         GROUP BY 1
       ) t ON t.day = d
       ORDER BY d`,
      [projectId]
    );
    return {
      totalTestCases: Number(total.rows[0]?.count || 0),
      bySuite: bySuite.rows.map((r) => ({ name: r.name, count: Number(r.count) })),
      byStatus,
      byPriority,
      addedByDate: addedByDate.rows.map((r) => ({ date: r.date, count: Number(r.count) })),
      updatedToday: Number(updatedCounts.rows[0]?.today || 0),
      updatedThisWeek: Number(updatedCounts.rows[0]?.this_week || 0),
      updatedThisMonth: Number(updatedCounts.rows[0]?.this_month || 0)
    };
  }

  private async cyclePassRateSeries(projectId: string, limit: number) {
    const res = await this.db.query<{
      id: string;
      name: string;
      created_at: string;
      total_cases: number;
      passed: number;
      failed: number;
      blocked: number;
      skipped: number;
    }>(
      `SELECT c.id, c.name, c.created_at,
              ${LegacyService.EXECUTION_BUCKET_COUNTS}
       FROM cycles c
       LEFT JOIN cycle_items ci ON ci.cycle_id = c.id
       LEFT JOIN executions e ON e.cycle_item_id = ci.id AND e.deleted_at IS NULL
       WHERE c.project_id = $1
       GROUP BY c.id
       ORDER BY c.created_at ASC`,
      [projectId]
    );
    const rows = res.rows.slice(-limit);
    return rows.map((r) => {
      const passed = Number(r.passed) || 0;
      const failed = Number(r.failed) || 0;
      const blocked = Number(r.blocked) || 0;
      const skipped = Number(r.skipped) || 0;
      const totalCases = Number(r.total_cases) || 0;
      const metrics = LegacyService.computeExecutionMetrics({ passed, failed, blocked, skipped, totalCases });
      return {
        id: r.id,
        name: r.name,
        createdAt: r.created_at,
        total: totalCases,
        passed,
        failed,
        blocked,
        skipped,
        executed: metrics.executed,
        executionProgress: metrics.executionProgress,
        passRate: metrics.passRate
      };
    });
  }

  private async suiteHealth(projectId: string) {
    const res = await this.db.query<{
      suite_name: string;
      total_cases: string;
      passed: string;
      failed: string;
      blocked: string;
      skipped: string;
    }>(
      `SELECT COALESCE(s.name, 'Unassigned') AS suite_name,
              ${LegacyService.EXECUTION_BUCKET_COUNTS}
       FROM testcases t
       LEFT JOIN suites s ON s.id = t.suite_id
       LEFT JOIN cycle_items ci ON ci.testcase_id = t.id
       LEFT JOIN cycles c ON c.id = ci.cycle_id AND c.project_id = t.project_id
       LEFT JOIN executions e ON e.cycle_item_id = ci.id AND e.deleted_at IS NULL
       WHERE t.project_id = $1 AND t.deleted_at IS NULL
       GROUP BY s.name
       ORDER BY s.name`,
      [projectId]
    );
    return res.rows.map((r) => {
      const passed = Number(r.passed) || 0;
      const failed = Number(r.failed) || 0;
      const blocked = Number(r.blocked) || 0;
      const skipped = Number(r.skipped) || 0;
      const totalCases = Number(r.total_cases) || 0;
      const metrics = LegacyService.computeExecutionMetrics({ passed, failed, blocked, skipped, totalCases });
      // Percentages of settled cases (Passed+Failed+Blocked), matching Pass Rate everywhere else —
      // Skipped is neither a pass nor a fail, so it does not dilute these three.
      const settled = passed + failed + blocked;
      const pct = (n: number) => (settled > 0 ? Math.round((n / settled) * 100) : 0);
      return {
        suiteName: r.suite_name,
        executed: metrics.executed,
        skipped,
        executionProgress: metrics.executionProgress,
        passedPct: pct(passed),
        failedPct: pct(failed),
        blockedPct: pct(blocked)
      };
    });
  }

  private async coverageBySuite(projectId: string) {
    const res = await this.db.query<{ suite_name: string; total_cases: string; covered_cases: string }>(
      `SELECT COALESCE(s.name, 'Unassigned') AS suite_name,
              COUNT(DISTINCT t.id)::int AS total_cases,
              COUNT(DISTINCT covered.testcase_id)::int AS covered_cases
       FROM testcases t
       LEFT JOIN suites s ON s.id = t.suite_id
       LEFT JOIN LATERAL (
         SELECT ci.testcase_id
         FROM cycle_items ci
         JOIN executions e ON e.cycle_item_id = ci.id
         WHERE ci.testcase_id = t.id AND e.status IS NOT NULL AND e.status <> 'Untested'
         LIMIT 1
       ) covered ON true
       WHERE t.project_id = $1 AND t.deleted_at IS NULL
       GROUP BY s.name
       ORDER BY s.name`,
      [projectId]
    );
    return res.rows.map((r) => {
      const total = Number(r.total_cases) || 0;
      const covered = Number(r.covered_cases) || 0;
      const pct = total > 0 ? Math.round((covered / total) * 100) : 0;
      return { suiteName: r.suite_name, total, covered, pct };
    });
  }

  private async untestedP1Count(projectId: string) {
    const res = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM (
         SELECT t.id
         FROM testcases t
         LEFT JOIN cycle_items ci ON ci.testcase_id = t.id
         LEFT JOIN executions e ON e.cycle_item_id = ci.id
         WHERE t.project_id = $1 AND t.deleted_at IS NULL AND t.priority = 'P1'
         GROUP BY t.id
         HAVING COUNT(*) FILTER (WHERE e.status IS NOT NULL AND e.status <> 'Untested') = 0
       ) sub`,
      [projectId]
    );
    return Number(res.rows[0]?.count || 0);
  }

  private async detectFlakyTests(projectId: string) {
    const res = await this.db.query<{
      testcase_id: string;
      external_id: string;
      title: string;
      suite_name: string;
      status: string;
      run_name: string;
      run_created_at: string;
    }>(
      `SELECT ci.testcase_id, COALESCE(t.external_id, '') AS external_id,
              COALESCE(t.title, ci.snapshot_title, 'Untitled test case') AS title,
              COALESCE(s.name, 'Unassigned') AS suite_name,
              e.status, c.name AS run_name, c.created_at AS run_created_at
       FROM cycle_items ci
       JOIN executions e ON e.cycle_item_id = ci.id
       JOIN cycles c ON c.id = ci.cycle_id
       LEFT JOIN testcases t ON t.id = ci.testcase_id
       LEFT JOIN suites s ON s.id = t.suite_id
       WHERE c.project_id = $1 AND e.status IS NOT NULL AND e.status <> 'Untested'
       ORDER BY ci.testcase_id, c.created_at ASC`,
      [projectId]
    );
    const byTestcase = new Map<string, typeof res.rows>();
    for (const row of res.rows) {
      const list = byTestcase.get(row.testcase_id) || [];
      list.push(row);
      byTestcase.set(row.testcase_id, list);
    }
    const flaky: Body[] = [];
    for (const [testcaseId, rows] of byTestcase) {
      if (rows.length < 2) continue;
      const distinctStatuses = new Set(rows.map((r) => r.status));
      if (distinctStatuses.size < 2) continue;
      let flips = 0;
      for (let i = 1; i < rows.length; i++) {
        if (rows[i].status !== rows[i - 1].status) flips++;
      }
      const flipRate = flips / (rows.length - 1);
      flaky.push({
        testcaseId,
        externalId: rows[0].external_id,
        title: rows[0].title,
        suiteName: rows[0].suite_name,
        runs: rows.map((r) => ({ runName: r.run_name, status: r.status })),
        flipCount: flips,
        flakinessLabel: flipRate >= 0.5 ? "High" : flipRate >= 0.25 ? "Medium" : "Low"
      });
    }
    flaky.sort((a, b) => (b.flipCount as number) - (a.flipCount as number));
    return flaky.slice(0, 20);
  }

  async reportsOverview(projectId: string) {
    const [passRateSeries, suiteHealth, coverage, untestedP1, flaky] = await Promise.all([
      this.cyclePassRateSeries(projectId, 10),
      this.suiteHealth(projectId),
      this.coverageBySuite(projectId),
      this.untestedP1Count(projectId),
      this.detectFlakyTests(projectId)
    ]);
    const withRate = passRateSeries.filter((p) => p.passRate !== null);
    const trendDelta = withRate.length >= 2 ? withRate[withRate.length - 1].passRate! - withRate[0].passRate! : 0;
    const coverageGaps = coverage.filter((c) => c.pct < 70);

    const summaryParts: string[] = [];
    if (flaky.length > 0) {
      const top = flaky[0] as { suiteName: string; externalId: string };
      summaryParts.push(`${top.suiteName} suite has a flaky test (${top.externalId}) with inconsistent results across runs.`);
    }
    if (coverageGaps.length > 0) {
      const worst = coverageGaps[0];
      summaryParts.push(`${worst.suiteName} suite shows low coverage — only ${worst.covered} of ${worst.total} cases executed.`);
    }
    if (withRate.length >= 2) {
      summaryParts.push(`Overall pass rate ${trendDelta >= 0 ? "improved" : "declined"} ${Math.abs(trendDelta)}% over the last ${withRate.length} runs.`);
    }
    if (summaryParts.length === 0) summaryParts.push("Not enough execution history yet to generate insights.");

    return {
      passRateTrend: passRateSeries,
      trendDelta,
      suiteHealth,
      aiSummary: summaryParts.join(" "),
      flakyCount: flaky.length,
      coverageGapCount: coverageGaps.length,
      untestedP1Count: untestedP1
    };
  }

  async reportsInsights(projectId: string) {
    const [coverage, untestedP1, flaky, passRateSeries] = await Promise.all([
      this.coverageBySuite(projectId),
      this.untestedP1Count(projectId),
      this.detectFlakyTests(projectId),
      this.cyclePassRateSeries(projectId, 10)
    ]);
    const withRate = passRateSeries.filter((p) => p.passRate !== null);
    const avgPassRate = withRate.length > 0 ? withRate.reduce((sum, p) => sum + (p.passRate as number), 0) / withRate.length : 0;
    const avgCoverage = coverage.length > 0 ? coverage.reduce((sum, c) => sum + c.pct, 0) / coverage.length : 0;
    const untestedPenalty = untestedP1 === 0 ? 10 : Math.max(0, 10 - untestedP1);
    // v1 heuristic: 60% weight on recent pass rate, 30% on average suite coverage, up to
    // 10 bonus points for having no untested P1s, minus 5 points per detected flaky test.
    // Tunable — no historical baseline exists yet to calibrate weights against.
    const rawScore = avgPassRate * 0.6 + avgCoverage * 0.3 + untestedPenalty - flaky.length * 5;
    const healthScore = Math.max(0, Math.min(100, Math.round(rawScore)));
    const healthLabel = healthScore >= 70 ? "Healthy" : healthScore >= 40 ? "Needs attention" : "At risk";

    return {
      healthScore,
      healthLabel,
      flakyTests: flaky,
      coverageGaps: coverage.filter((c) => c.pct < 70),
      coverageBySuite: coverage,
      untestedP1Count: untestedP1
    };
  }

  async reportsTrends(projectId: string) {
    const [passRateSeries, bugRate] = await Promise.all([
      this.cyclePassRateSeries(projectId, 12),
      this.db.query<{ week: string; count: string }>(
        `SELECT to_char(d::date, 'YYYY-MM-DD') AS week, COALESCE(b.cnt, 0)::int AS count
         FROM generate_series(date_trunc('week', now() - interval '6 weeks'), date_trunc('week', now()), interval '1 week') AS d
         LEFT JOIN (
           SELECT date_trunc('week', created_at) AS week, COUNT(*) AS cnt
           FROM bugs WHERE project_id = $1
           GROUP BY 1
         ) b ON b.week = d
         ORDER BY d`,
        [projectId]
      )
    ]);
    const withRate = passRateSeries.filter((p) => p.passRate !== null);
    const trendDelta = withRate.length >= 2 ? withRate[withRate.length - 1].passRate! - withRate[0].passRate! : 0;
    return {
      passRateTrend: passRateSeries,
      trendDelta,
      executionVelocity: passRateSeries.map((p) => ({ name: p.name, count: p.executed })),
      bugDiscoveryRate: bugRate.rows.map((r) => ({ week: r.week, count: Number(r.count) }))
    };
  }

  async projectDashboardSummary(userId: string | null | undefined, projectId: string) {
    await this.requireProjectAccess(userId, projectId);
    const [counts, requirements, bugSeverity, activeRuns, addedThisWeek, passRateWindows] = await Promise.all([
      this.analytics(projectId),
      this.requirementsSummary(projectId, userId),
      this.db.query<{ severity: string; count: string }>(
        `SELECT severity, COUNT(*)::int AS count FROM bugs WHERE project_id = $1 AND status IN ('Open', 'Reopened') GROUP BY severity`,
        [projectId]
      ),
      this.db.query<{ count: string }>(`SELECT COUNT(*)::int AS count FROM cycles WHERE project_id = $1 AND status = 'In Progress'`, [projectId]),
      this.db.query<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM testcases_active WHERE project_id = $1 AND created_at >= now() - interval '7 days'`,
        [projectId]
      ),
      // Compares the pass rate of executions recorded in the last 7 days against the 7 days
      // before that, so the dashboard's "+N% this week" badge reflects real execution activity
      // rather than an all-time trend. Settled statuses only (Passed/Failed/Blocked) — matching
      // computeExecutionMetrics' Pass Rate, Skipped and Retest are not part of this denominator.
      this.db.query<{ passed_recent: string; settled_recent: string; passed_prior: string; settled_prior: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE e.status = 'Passed' AND e.executed_at >= now() - interval '7 days')::int AS passed_recent,
           COUNT(*) FILTER (WHERE e.status IN ('Passed', 'Failed', 'Blocked') AND e.executed_at >= now() - interval '7 days')::int AS settled_recent,
           COUNT(*) FILTER (WHERE e.status = 'Passed' AND e.executed_at >= now() - interval '14 days' AND e.executed_at < now() - interval '7 days')::int AS passed_prior,
           COUNT(*) FILTER (WHERE e.status IN ('Passed', 'Failed', 'Blocked') AND e.executed_at >= now() - interval '14 days' AND e.executed_at < now() - interval '7 days')::int AS settled_prior
         FROM executions e
         JOIN cycle_items ci ON ci.id = e.cycle_item_id
         JOIN cycles c ON c.id = ci.cycle_id
         WHERE c.project_id = $1`,
        [projectId]
      )
    ]);

    const bySeverity = { Critical: 0, High: 0, Medium: 0, Low: 0 } as Record<string, number>;
    for (const row of bugSeverity.rows) {
      if (row.severity in bySeverity) bySeverity[row.severity] = Number(row.count);
    }
    const openBugsTotal = Object.values(bySeverity).reduce((a, b) => a + b, 0);

    const metrics = LegacyService.computeExecutionMetrics({
      passed: counts.executionStatus.Passed || 0,
      failed: counts.executionStatus.Failed || 0,
      blocked: counts.executionStatus.Blocked || 0,
      skipped: counts.executionStatus.Skipped || 0,
      totalCases: counts.executionTotal
    });

    const w = passRateWindows.rows[0];
    const recentSettled = Number(w?.settled_recent || 0);
    const priorSettled = Number(w?.settled_prior || 0);
    const recentRate = recentSettled > 0 ? (Number(w!.passed_recent) / recentSettled) * 100 : null;
    const priorRate = priorSettled > 0 ? (Number(w!.passed_prior) / priorSettled) * 100 : null;
    const passRateDeltaThisWeek = recentRate !== null && priorRate !== null ? Math.round(recentRate - priorRate) : null;

    const totalRequirements = requirements.all.total;
    const coveredRequirements = requirements.all.covered;
    const coveragePct = totalRequirements > 0 ? Math.round((coveredRequirements / totalRequirements) * 100) : null;

    return {
      testCases: { total: counts.testCaseCount, addedThisWeek: Number(addedThisWeek.rows[0]?.count || 0) },
      passRate: { value: metrics.passRate, deltaThisWeek: passRateDeltaThisWeek },
      executionProgress: { value: metrics.executionProgress },
      openBugs: { total: openBugsTotal, bySeverity },
      coverage: { pct: coveragePct, totalRequirements },
      plans: counts.planCount,
      suites: counts.suiteCount,
      activeRuns: Number(activeRuns.rows[0]?.count || 0)
    };
  }

  async listActivityForUser(userId: string | null | undefined, projectId: string, query: Body) {
    await this.requireProjectAccess(userId, projectId);
    return this.listActivity(projectId, query);
  }

  async activitySummaryForUser(userId: string | null | undefined, projectId: string) {
    await this.requireProjectAccess(userId, projectId);
    return this.activitySummary(projectId);
  }

  /**
   * The filters shared by the per-project feed and the workspace-wide rollup.
   *
   * Every column is qualified with the `ae.` alias. The outer select of activityEventsSql is
   * `FROM activity_events ae LEFT JOIN projects pr`, and `projects` also has a `created_at`, so an
   * unqualified `created_at >= $n` — which is what `?since=` built — raised Postgres 42702
   * `column reference "created_at" is ambiguous` and surfaced as a 500. The two summary callers
   * already qualified their predicates; these two did not.
   *
   * `since` and the two id filters are also validated here rather than being handed to Postgres:
   * an unparseable timestamp reached `$n::timestamptz` as 22007 and a malformed id reached a uuid
   * column as 22P02, both 500s on what is really a bad query parameter.
   */
  private activityFeedFilters(
    query: Body,
    values: any[],
    filters: string[],
    { withProject }: { withProject: boolean }
  ): void {
    const entityType = String(query.entityType || "").trim();
    const actorId = String(query.actorId || "").trim();
    const projectId = String(query.projectId || "").trim();
    const search = String(query.search || "").trim();
    const since = String(query.since || "").trim();

    if (entityType) {
      values.push(entityType.split(",").map((t) => t.trim()).filter(Boolean));
      filters.push(`ae.entity_type = ANY($${values.length}::text[])`);
    }
    if (actorId) {
      if (!isUuid(actorId)) throw new BadRequestException({ error: "actorId must be a valid id" });
      values.push(actorId);
      filters.push(`ae.actor_id = $${values.length}`);
    }
    if (withProject && projectId) {
      if (!isUuid(projectId)) throw new BadRequestException({ error: "projectId must be a valid id" });
      values.push(projectId);
      filters.push(`ae.project_id = $${values.length}`);
    }
    if (since) {
      if (Number.isNaN(Date.parse(since))) {
        throw new BadRequestException({ error: "since must be a valid ISO 8601 timestamp" });
      }
      values.push(new Date(since).toISOString());
      filters.push(`ae.created_at >= $${values.length}::timestamptz`);
    }
    if (search) {
      values.push(`%${search.toLowerCase()}%`);
      filters.push(
        `(lower(coalesce(ae.entity_name,'')) LIKE $${values.length} OR lower(coalesce(ae.actor_name,'')) LIKE $${values.length} OR lower(ae.action) LIKE $${values.length})`
      );
    }
  }

  async listActivity(projectId: string, query: Body) {
    const limit = pageNumber(query.limit, 30, 0, 100);
    const offset = pageNumber(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const values: any[] = [projectId];
    const filters = ["ae.project_id = $1"];
    this.activityFeedFilters(query, values, filters, { withProject: false });
    const where = filters.join(" AND ");

    const eventsSql = this.activityEventsSql(where);

    const total = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM (${eventsSql}) counted`,
      values
    );
    values.push(limit, offset);
    const res = await this.db.query(
      `${eventsSql} ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { list: res.rows.map(toCamel), total: Number(total.rows[0]?.count || 0) };
  }

  // Testcase created/updated/deleted are intentionally NOT synthesized from the `testcases`
  // table here — logProjectActivity already records testcase_created/testcase_updated/
  // testcase_deleted (with real actor attribution) on every mutation, so a timestamp-derived
  // row here would double-count them. Suites/plans/cycles/bugs have no equivalent audit trail,
  // so those still derive synthetic created/updated rows from the base tables.
  //
  // projectScopeSql parameterizes the "which project(s)" predicate: the default (single
  // project, used by listActivity/activitySummary) is `project_id = $1`; the workspace-wide
  // rollup (listWorkspaceActivity/workspaceActivitySummary) passes an org-derived subquery
  // instead. It's always one of these two hardcoded literals, never caller/request input.
  //
  // orgOnlySql, when set, adds a second audit_logs branch for pure workspace-level events
  // that have no project_id at all (logWorkspaceActivity rows: invites, workspace membership
  // changes) — these can never match projectScopeSql since project_id IS NULL, so the
  // workspace rollup needs this extra branch to include them; the per-project feed omits it
  // (default null) since those events aren't relevant to a single project's own history.
  private activityEventsSql(outerWhere: string, projectScopeSql: string = "project_id = $1", orgOnlySql: string | null = null): string {
    const orgOnlyBranch = orgOnlySql
      ? `
        UNION ALL
        SELECT
          NULL::uuid AS project_id, a.id::text, a.actor_id, u.email, COALESCE(u.name, g.display_name),
          CASE WHEN g.id IS NOT NULL THEN 'agent' WHEN u.id IS NOT NULL THEN 'user' END,
          a.action::text, a.entity_type::text, a.entity_id::text, a.entity_name::text, a.diff::text, a.created_at
        FROM audit_logs a
        LEFT JOIN users u ON u.id = a.actor_id
        LEFT JOIN agents g ON g.id = a.actor_id
        WHERE a.project_id IS NULL AND ${orgOnlySql}
      `
      : "";
    return `
      WITH activity_events AS (
        SELECT
          project_id,
          ('suite-created-' || id::text) AS id,
          NULL::uuid AS actor_id,
          NULL::text AS actor_email,
          NULL::text AS actor_name,
          NULL::text AS actor_kind,
          'created'::text AS action,
          'suite'::text AS entity_type,
          id::text AS entity_id,
          name AS entity_name,
          NULL::text AS diff,
          created_at
        FROM suites
        WHERE ${projectScopeSql}

        UNION ALL
        SELECT
          project_id, ('suite-updated-' || id::text), NULL::uuid, NULL::text, NULL::text, NULL::text,
          'updated'::text, 'suite'::text, id::text, name, NULL::text, updated_at
        FROM suites
        WHERE ${projectScopeSql} AND updated_at > created_at + interval '1 second'

        UNION ALL
        SELECT
          p.project_id, ('plan-created-' || p.id::text), p.owner_id, u.email, u.name,
          CASE WHEN p.owner_id IS NOT NULL THEN 'user' END,
          'created'::text, 'plan'::text, p.id::text, p.name, NULL::text, p.created_at
        FROM plans p
        LEFT JOIN users u ON u.id = p.owner_id
        WHERE ${projectScopeSql}

        UNION ALL
        SELECT
          project_id, ('plan-updated-' || id::text), NULL::uuid, NULL::text, NULL::text, NULL::text,
          'updated'::text, 'plan'::text, id::text, name, NULL::text, updated_at
        FROM plans
        WHERE ${projectScopeSql} AND updated_at > created_at + interval '1 second'

        UNION ALL
        SELECT
          c.project_id, ('cycle-created-' || c.id::text), c.owner_id, u.email, u.name,
          CASE WHEN c.owner_id IS NOT NULL THEN 'user' END,
          'created'::text, 'cycle'::text, c.id::text, c.name, NULL::text, c.created_at
        FROM cycles c
        LEFT JOIN users u ON u.id = c.owner_id
        WHERE ${projectScopeSql}

        UNION ALL
        SELECT
          project_id, ('cycle-updated-' || id::text), NULL::uuid, NULL::text, NULL::text, NULL::text,
          'updated'::text, 'cycle'::text, id::text, name, NULL::text, updated_at
        FROM cycles
        WHERE ${projectScopeSql} AND updated_at > created_at + interval '1 second'

        UNION ALL
        SELECT
          b.project_id, ('bug-created-' || b.id::text), b.reported_by, u.email, u.name,
          CASE WHEN b.reported_by IS NOT NULL THEN 'user' END,
          'created'::text, 'bug'::text, b.id::text, b.title, NULL::text, b.created_at
        FROM bugs b
        LEFT JOIN users u ON u.id = b.reported_by
        WHERE ${projectScopeSql}

        UNION ALL
        SELECT
          b.project_id, ('bug-updated-' || b.id::text), b.reported_by, u.email, u.name,
          CASE WHEN b.reported_by IS NOT NULL THEN 'user' END,
          'updated'::text, 'bug'::text, b.id::text, b.title, NULL::text, b.updated_at
        FROM bugs b
        LEFT JOIN users u ON u.id = b.reported_by
        WHERE ${projectScopeSql} AND b.updated_at > b.created_at + interval '1 second'

        UNION ALL
        SELECT
          a.project_id, a.id::text, a.actor_id, u.email, COALESCE(u.name, g.display_name),
          CASE WHEN g.id IS NOT NULL THEN 'agent' WHEN u.id IS NOT NULL THEN 'user' END,
          a.action::text, a.entity_type::text, a.entity_id::text, a.entity_name::text, a.diff::text, a.created_at
        FROM audit_logs a
        LEFT JOIN users u ON u.id = a.actor_id
        LEFT JOIN agents g ON g.id = a.actor_id
        WHERE a.project_id IS NOT NULL AND ${projectScopeSql}
        ${orgOnlyBranch}
      )
      -- The Zyra chat flow calls the shared createTestCase/patchTestCaseFromZyra helpers (which
      -- already log testcase_created/testcase_updated) and then logs a second zyra_created/
      -- zyra_updated/zyra_archived row for the same entity a moment later, so both would render
      -- as duplicate feed rows for the same mutation. Drop the plain testcase_* row whenever a
      -- zyra_* sibling exists for the same entity within a few seconds; the zyra_* row carries
      -- the AI-specific action label and reason, and actor attribution already says who/what did it.
      SELECT ae.*, pr.name AS project_name
      FROM activity_events ae
      LEFT JOIN projects pr ON pr.id = ae.project_id
      WHERE ${outerWhere}
        AND NOT (
          ae.action IN ('testcase_created', 'testcase_updated')
          AND EXISTS (
            SELECT 1 FROM activity_events z
            WHERE z.entity_id = ae.entity_id
              AND z.action IN ('zyra_created', 'zyra_updated', 'zyra_archived')
              AND abs(extract(epoch FROM z.created_at - ae.created_at)) < 5
          )
        )
    `;
  }

  // Powers the Activity screen's right-hand summary panel: this-week action-category counts,
  // an actor leaderboard, and a per-entity-type breakdown — all scoped to the same trailing
  // 7-day window so the three widgets read as one consistent "this week" snapshot.
  async activitySummary(projectId: string) {
    const eventsSql = this.activityEventsSql(
      "ae.project_id = $1 AND ae.created_at >= now() - interval '7 days'"
    );
    const [weekly, leaderboard, byEntityType] = await Promise.all([
      this.db.query(
        `
        SELECT
          COUNT(*) FILTER (WHERE action ILIKE 'zyra%')::int AS ai_actions,
          COUNT(*) FILTER (WHERE action NOT ILIKE 'zyra%' AND action ILIKE '%creat%')::int AS created,
          COUNT(*) FILTER (WHERE action NOT ILIKE 'zyra%' AND action ILIKE '%updat%')::int AS updated,
          COUNT(*) FILTER (WHERE action NOT ILIKE 'zyra%' AND action ILIKE '%delet%')::int AS deleted,
          COUNT(*)::int AS total
        FROM (${eventsSql}) e
        `,
        [projectId]
      ),
      this.db.query(
        `
        SELECT actor_id, actor_name, actor_email, actor_kind, COUNT(*)::int AS count
        FROM (${eventsSql}) e
        WHERE actor_id IS NOT NULL
        GROUP BY actor_id, actor_name, actor_email, actor_kind
        ORDER BY count DESC
        LIMIT 6
        `,
        [projectId]
      ),
      this.db.query(
        `
        SELECT entity_type, COUNT(*)::int AS count
        FROM (${eventsSql}) e
        GROUP BY entity_type
        ORDER BY count DESC
        `,
        [projectId]
      )
    ]);

    const w = weekly.rows[0] || {};
    return {
      weekly: {
        created: Number(w.created || 0),
        updated: Number(w.updated || 0),
        aiActions: Number(w.ai_actions || 0),
        deleted: Number(w.deleted || 0),
        total: Number(w.total || 0)
      },
      activeMembers: leaderboard.rows.map(toCamel),
      byEntityType: byEntityType.rows.map(toCamel)
    };
  }

  // ─── Workspace-wide Activity (master feed) ──────────────────────────────────
  // Owner-only rollup across every project in the workspace, plus pure workspace-level
  // events (invites, membership changes) that have no project at all. Same shape/filters
  // as the per-project feed, with an added projectId filter and projectName on every row.

  async workspaceActivity(userId: string | null | undefined, query: Body) {
    const uid = this.requireUser(userId);
    const workspace = await this.workspace(uid);
    if (this.normalizeRole(workspace.role) !== "owner")
      throw new ForbiddenException({ error: "Only the workspace owner can view the workspace activity feed" });
    return this.listWorkspaceActivity(workspace.id, query);
  }

  async workspaceActivitySummaryForUser(userId: string | null | undefined) {
    const uid = this.requireUser(userId);
    const workspace = await this.workspace(uid);
    if (this.normalizeRole(workspace.role) !== "owner")
      throw new ForbiddenException({ error: "Only the workspace owner can view the workspace activity feed" });
    return this.workspaceActivitySummary(workspace.id);
  }

  private async listWorkspaceActivity(organizationId: string, query: Body) {
    const limit = pageNumber(query.limit, 30, 0, 100);
    const offset = pageNumber(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const values: any[] = [organizationId];
    const filters = ["true"];
    this.activityFeedFilters(query, values, filters, { withProject: true });
    const where = filters.join(" AND ");

    const eventsSql = this.activityEventsSql(
      where,
      "project_id IN (SELECT id FROM projects WHERE organization_id = $1)",
      "organization_id = $1"
    );

    const total = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM (${eventsSql}) counted`,
      values
    );
    values.push(limit, offset);
    const res = await this.db.query(
      `${eventsSql} ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { list: res.rows.map(toCamel), total: Number(total.rows[0]?.count || 0) };
  }

  private async workspaceActivitySummary(organizationId: string) {
    const eventsSql = this.activityEventsSql(
      "ae.created_at >= now() - interval '7 days'",
      "project_id IN (SELECT id FROM projects WHERE organization_id = $1)",
      "organization_id = $1"
    );
    const [weekly, leaderboard, byEntityType] = await Promise.all([
      this.db.query(
        `
        SELECT
          COUNT(*) FILTER (WHERE action ILIKE 'zyra%')::int AS ai_actions,
          COUNT(*) FILTER (WHERE action NOT ILIKE 'zyra%' AND action ILIKE '%creat%')::int AS created,
          COUNT(*) FILTER (WHERE action NOT ILIKE 'zyra%' AND action ILIKE '%updat%')::int AS updated,
          COUNT(*) FILTER (WHERE action NOT ILIKE 'zyra%' AND action ILIKE '%delet%')::int AS deleted,
          COUNT(*)::int AS total
        FROM (${eventsSql}) e
        `,
        [organizationId]
      ),
      this.db.query(
        `
        SELECT actor_id, actor_name, actor_email, actor_kind, COUNT(*)::int AS count
        FROM (${eventsSql}) e
        WHERE actor_id IS NOT NULL
        GROUP BY actor_id, actor_name, actor_email, actor_kind
        ORDER BY count DESC
        LIMIT 6
        `,
        [organizationId]
      ),
      this.db.query(
        `
        SELECT entity_type, COUNT(*)::int AS count
        FROM (${eventsSql}) e
        GROUP BY entity_type
        ORDER BY count DESC
        `,
        [organizationId]
      )
    ]);

    const w = weekly.rows[0] || {};
    return {
      weekly: {
        created: Number(w.created || 0),
        updated: Number(w.updated || 0),
        aiActions: Number(w.ai_actions || 0),
        deleted: Number(w.deleted || 0),
        total: Number(w.total || 0)
      },
      activeMembers: leaderboard.rows.map(toCamel),
      byEntityType: byEntityType.rows.map(toCamel)
    };
  }

  /*
   * The v1 flat notes surface, superseded by Knowledge Base v2 above but still routed.
   *
   * Every method here now takes the caller and resolves the project first. They previously took no
   * caller at all — the controller methods had no @Req() — so an anonymous request could list any
   * project's notes by id, rewrite one, or delete one, with no session and from any workspace. The
   * item routes also resolve the item WITHIN the project: an id alone is not authority, or a member
   * of one project could delete another project's note by guessing its id.
   */
  async listKnowledge(projectId: string, userId: string | null | undefined, query: Body) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const values: any[] = [projectId];
    const filters = ["project_id = $1"];
    if (query.type) {
      values.push(query.type);
      filters.push(`item_type = $${values.length}`);
    }
    if (query.search) {
      values.push(`%${String(query.search).toLowerCase()}%`);
      filters.push(`(lower(title) LIKE $${values.length} OR lower(coalesce(content,'')) LIKE $${values.length})`);
    }
    const res = await this.db.query(`SELECT * FROM knowledge_base_items WHERE ${filters.join(" AND ")} ORDER BY updated_at DESC`, values);
    return { list: res.rows.map(toCamel), total: res.rowCount };
  }

  async createKnowledge(projectId: string, userId: string | null | undefined, body: Body) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    const res = await this.db.query(
      `INSERT INTO knowledge_base_items (project_id, item_type, title, content, created_by)
       VALUES ($1, 'note', $2, $3, $4) RETURNING *`,
      [projectId, body.title || "Untitled note", body.content || "", uid]
    );
    return toCamel(res.rows[0]);
  }

  /**
   * Resolves a v1 note inside the project the caller reached it through.
   *
   * Scoping to project_id is the load-bearing half: without it, holding an item id was enough to
   * read, rewrite or delete a note belonging to any project in the deployment.
   */
  private async knowledgeItem(projectId: string, itemId: string): Promise<Body> {
    if (!isUuid(itemId)) throw new NotFoundException({ error: "Knowledge base item not found" });
    const res = await this.db.query("SELECT * FROM knowledge_base_items WHERE id = $1 AND project_id = $2", [
      itemId,
      projectId
    ]);
    if (!res.rows[0]) throw new NotFoundException({ error: "Knowledge base item not found" });
    return res.rows[0];
  }

  async getKnowledge(projectId: string, userId: string | null | undefined, itemId: string) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    return toCamel(await this.knowledgeItem(projectId, itemId));
  }

  async updateKnowledge(projectId: string, userId: string | null | undefined, itemId: string, body: Body) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    await this.knowledgeItem(projectId, itemId);
    await this.db.query(
      "UPDATE knowledge_base_items SET title=COALESCE($2,title), content=COALESCE($3,content), updated_at=now() WHERE id=$1",
      [itemId, body.title || null, body.content || null]
    );
  }

  async deleteKnowledge(projectId: string, userId: string | null | undefined, itemId: string) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    await this.knowledgeItem(projectId, itemId);
    await this.db.query("DELETE FROM knowledge_base_items WHERE id = $1", [itemId]);
  }

  /**
   * The v1 per-item file route, which has never served bytes — it returns an empty object.
   *
   * Kept routed for the old clients that still call it, but no longer answers without a session: an
   * unauthenticated 200 on a project-scoped path is the shape that let bug 14 through, and a route
   * that looks like it serves a file must not be the one exception.
   */
  async knowledgeItemFile(projectId: string, userId: string | null | undefined, itemId: string) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    await this.knowledgeItem(projectId, itemId);
    return {};
  }

  // ─── Knowledge Base v2 (folders / documents / files) ──────────────────────────

  private static readonly KB_VERSION_SNAPSHOT_MINUTES = 15;
  // Mirrors knowledge_documents.title VARCHAR(512) — checked here so an over-limit title comes
  // back as a clear 400 instead of a raw Postgres "value too long" error.
  private static readonly KB_DOCUMENT_TITLE_MAX_LENGTH = 512;
  // A product-level cap, tighter than the knowledge_folders.name VARCHAR(255) column — folder
  // names render in narrow tree/breadcrumb UI, so they're kept short rather than merely DB-legal.
  // Mirrored in the frontend at lib/validation.ts (KB_FOLDER_NAME_MAX_LENGTH) — keep both in sync.
  private static readonly KB_FOLDER_NAME_MAX_LENGTH = 50;
  // Mirrors the frontend's own payload-size guard (MAX_DOCUMENT_PAYLOAD_BYTES in the document
  // editor page). The API is reachable directly, so the limit needs to be enforced here too.
  private static readonly KB_DOCUMENT_MAX_PAYLOAD_BYTES = 20 * 1024 * 1024;
  private static readonly KB_DOCUMENT_COLUMNS = `id, organization_id, project_id, folder_id, title, content_json, content_html, content_text,
    document_type, status, is_ai_generated, source_provider, source_external_id, source_url,
    source_role, source_synced_by, source_synced_at, is_read_only,
    created_by, updated_by, reviewed_by, reviewed_at, is_deleted, created_at, updated_at, deleted_at`;

  private async kbProjectRole(userId: string, projectId: string): Promise<"owner" | "manager" | "qa_engineer"> {
    const res = await this.db.query<{ role: string }>(
      "SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2",
      [projectId, userId]
    );
    return this.normalizeRole(res.rows[0]?.role || "");
  }

  private kbRequireOwnerOrManager(role: string) {
    if (role !== "owner" && role !== "manager")
      throw new ForbiddenException({ error: "Only owners and managers can perform this action" });
  }

  private kbRequireMutateAccess(role: string, ownerId: string | null, userId: string) {
    if (role === "owner" || role === "manager") return;
    if (ownerId && ownerId === userId) return;
    throw new ForbiddenException({ error: "You can only modify items you created" });
  }

  // A malformed id gets the same answer as a well-formed one that doesn't exist. Without the guard
  // the failed uuid cast surfaces as a 500, so a URL typo reads as a server fault — the same reason
  // isUuid() guards the custom-field and attachment resolvers.
  private async kbFolder(projectId: string, folderId: string): Promise<Body> {
    if (!isUuid(folderId)) throw new NotFoundException({ error: "Folder not found" });
    const res = await this.db.query(
      "SELECT * FROM knowledge_folders WHERE id = $1 AND project_id = $2 AND is_deleted = false",
      [folderId, projectId]
    );
    if (!res.rows[0]) throw new NotFoundException({ error: "Folder not found" });
    return res.rows[0];
  }

  private async kbBreadcrumb(folderId: string): Promise<Array<{ id: string; name: string }>> {
    const res = await this.db.query<{ id: string; name: string }>(
      `WITH RECURSIVE path AS (
         SELECT id, name, parent_folder_id, 0 AS depth FROM knowledge_folders WHERE id = $1
         UNION ALL
         SELECT kf.id, kf.name, kf.parent_folder_id, path.depth + 1
         FROM knowledge_folders kf JOIN path ON kf.id = path.parent_folder_id
       )
       SELECT id, name FROM path ORDER BY depth DESC`,
      [folderId]
    );
    return res.rows;
  }

  /**
   * A folder name that is both column-legal and short enough to render.
   *
   * `knowledge_folders.name` is VARCHAR(255). Neither create nor rename bounded the input, so a longer
   * name reached Postgres and raised 22001 (string_data_right_truncation) — an error code no handler
   * caught, so the request answered 500 Internal Server Error. Basecamp 10199204536 reported that
   * against rename; create had the identical gap.
   *
   * The enforced limit is the tighter product cap, KB_FOLDER_NAME_MAX_LENGTH, not the column width —
   * folder names render in narrow tree/breadcrumb UI. The frontend mirrors the same constant in
   * lib/validation.ts, so both surfaces refuse at the same length with the same message.
   *
   * Validated at the edge so the caller gets a field-level 400 naming the limit. Since the product cap
   * is well under the column width, 22001 is now unreachable through either folder method; the catch
   * that updateKnowledgeFolder still carries is left as a backstop for any path that reaches the
   * column another way.
   */
  private kbFolderName(raw: unknown): string {
    const name = String(raw ?? "").trim();
    if (!name) throw new BadRequestException({ error: "Folder name is required" });
    if (name.length > LegacyService.KB_FOLDER_NAME_MAX_LENGTH) {
      throw new BadRequestException({
        error: `Folder name must be at most ${LegacyService.KB_FOLDER_NAME_MAX_LENGTH} characters`
      });
    }
    return name;
  }

  async createKnowledgeFolder(projectId: string, userId: string | null | undefined, body: Body) {
    const uid = this.requireUser(userId);
    const project = await this.requireProjectAccess(uid, projectId);
    const name = this.kbFolderName(body.name);

    let parentFolderId = body.parentFolderId ? String(body.parentFolderId) : null;
    if (parentFolderId) {
      await this.kbFolder(projectId, parentFolderId);
    } else {
      const root = await this.db.query<{ id: string }>(
        "SELECT id FROM knowledge_folders WHERE project_id = $1 AND is_root = true",
        [projectId]
      );
      parentFolderId = root.rows[0]?.id || null;
    }

    try {
      const res = await this.db.query(
        `INSERT INTO knowledge_folders (organization_id, project_id, parent_folder_id, name, description, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *`,
        [project.organization_id, projectId, parentFolderId, name, body.description || null, uid]
      );
      await this.logProjectActivity(projectId, uid, "created", "knowledge_folder", res.rows[0].id, name, {});
      return toCamel(res.rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        throw new BadRequestException({ error: "A folder with this name already exists here" });
      throw error;
    }
  }

  async getKnowledgeFolderTree(projectId: string, userId: string | null | undefined) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const res = await this.db.query(
      "SELECT id, parent_folder_id, name, description, is_root FROM knowledge_folders WHERE project_id = $1 AND is_deleted = false ORDER BY name",
      [projectId]
    );
    const rows = res.rows.map(toCamel);
    const byParent = new Map<string, Body[]>();
    for (const row of rows) {
      const key = row.parentFolderId || "root";
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key)!.push(row);
    }
    const build = (node: Body): Body => ({ ...node, children: (byParent.get(node.id) || []).map(build) });
    const root = rows.find((row) => row.isRoot);
    if (!root) throw new NotFoundException({ error: "Knowledge base root folder not found" });
    return build(root);
  }

  async getKnowledgeFolder(projectId: string, userId: string | null | undefined, folderId: string) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const folder = await this.kbFolder(projectId, folderId);
    const breadcrumb = await this.kbBreadcrumb(folderId);
    return { ...toCamel(folder), breadcrumb };
  }

  // Project-wide counts (not just the folder currently in view) for the listing screen's
  // stat tiles. Root folder is excluded from the folder count / total since it's a
  // container, not a listable item — mirrors how the folder tree itself hides the root row.
  async knowledgeBaseSummary(projectId: string, userId: string | null | undefined) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const [folders, documents, files] = await Promise.all([
      this.db.query<{ count: string }>(
        "SELECT COUNT(*)::int AS count FROM knowledge_folders WHERE project_id = $1 AND is_root = false AND is_deleted = false",
        [projectId]
      ),
      this.db.query<{ count: string }>(
        "SELECT COUNT(*)::int AS count FROM knowledge_documents WHERE project_id = $1 AND is_deleted = false",
        [projectId]
      ),
      this.db.query<{ count: string }>(
        "SELECT COUNT(*)::int AS count FROM knowledge_files WHERE project_id = $1 AND is_deleted = false",
        [projectId]
      )
    ]);
    const folderCount = Number(folders.rows[0]?.count || 0);
    const documentCount = Number(documents.rows[0]?.count || 0);
    const fileCount = Number(files.rows[0]?.count || 0);
    return { folders: folderCount, documents: documentCount, files: fileCount, total: documentCount + fileCount };
  }

  async updateKnowledgeFolder(projectId: string, userId: string | null | undefined, folderId: string, body: Body) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    const folder = await this.kbFolder(projectId, folderId);
    const role = await this.kbProjectRole(uid, projectId);
    this.kbRequireMutateAccess(role, folder.created_by, uid);

    // Bounded before the statement runs: an over-long name used to reach the column and come back as
    // 22001, which nothing caught — so a rename answered 500. Basecamp 10199204536.
    const nextName = body.name === undefined || body.name === null ? null : this.kbFolderName(body.name);

    try {
      const res = await this.db.query(
        `UPDATE knowledge_folders SET name = COALESCE($3, name), description = COALESCE($4, description),
         updated_by = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [folderId, uid, nextName, body.description ?? null]
      );
      await this.logProjectActivity(projectId, uid, "updated", "knowledge_folder", folderId, res.rows[0].name, {});
      return toCamel(res.rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        throw new BadRequestException({ error: "A folder with this name already exists here" });
      // Backstop: any other route to an over-long value must still be a 400, never a 500.
      if ((error as { code?: string }).code === "22001")
        throw new BadRequestException({
          error: `Folder name must be at most ${LegacyService.KB_FOLDER_NAME_MAX_LENGTH} characters`
        });
      throw error;
    }
  }

  async moveKnowledgeFolder(projectId: string, userId: string | null | undefined, folderId: string, body: Body) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    const folder = await this.kbFolder(projectId, folderId);
    if (folder.is_root) throw new BadRequestException({ error: "The root folder cannot be moved" });
    const role = await this.kbProjectRole(uid, projectId);
    this.kbRequireMutateAccess(role, folder.created_by, uid);

    const targetParentId = String(body.parentFolderId || "");
    if (!targetParentId) throw new BadRequestException({ error: "parentFolderId is required" });
    await this.kbFolder(projectId, targetParentId);

    const invalid = await this.db.query(
      `WITH RECURSIVE descendants AS (
         SELECT id FROM knowledge_folders WHERE id = $1
         UNION ALL
         SELECT kf.id FROM knowledge_folders kf JOIN descendants d ON kf.parent_folder_id = d.id
       )
       SELECT 1 FROM descendants WHERE id = $2`,
      [folderId, targetParentId]
    );
    if (invalid.rows[0])
      throw new BadRequestException({ error: "A folder cannot be moved into itself or one of its subfolders" });

    try {
      const res = await this.db.query(
        "UPDATE knowledge_folders SET parent_folder_id = $2, updated_by = $3, updated_at = now() WHERE id = $1 RETURNING *",
        [folderId, targetParentId, uid]
      );
      await this.logProjectActivity(projectId, uid, "moved", "knowledge_folder", folderId, res.rows[0].name, {});
      return toCamel(res.rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        throw new BadRequestException({ error: "A folder with this name already exists in the destination" });
      throw error;
    }
  }

  async deleteKnowledgeFolder(projectId: string, userId: string | null | undefined, folderId: string) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    const folder = await this.kbFolder(projectId, folderId);
    if (folder.is_root) throw new BadRequestException({ error: "The root folder cannot be deleted" });
    const role = await this.kbProjectRole(uid, projectId);
    this.kbRequireMutateAccess(role, folder.created_by, uid);

    const descendantsCte = `WITH RECURSIVE descendants AS (
      SELECT id FROM knowledge_folders WHERE id = $1
      UNION ALL
      SELECT kf.id FROM knowledge_folders kf JOIN descendants d ON kf.parent_folder_id = d.id
    )`;

    const filesToPurge = await this.db.query<{ storage_key: string }>(
      `${descendantsCte} SELECT storage_key FROM knowledge_files WHERE folder_id IN (SELECT id FROM descendants) AND is_deleted = false`,
      [folderId]
    );

    await this.db.transaction(async (client) => {
      await client.query(
        `${descendantsCte} UPDATE knowledge_folders SET is_deleted = true, deleted_at = now(), updated_at = now(), updated_by = $2
         WHERE id IN (SELECT id FROM descendants)`,
        [folderId, uid]
      );
      await client.query(
        // The Zyra memory document survives its folder being deleted — otherwise deleting the AI
        // memory folder is a way around the guard in deleteKnowledgeDocument.
        `${descendantsCte} UPDATE knowledge_documents SET is_deleted = true, deleted_at = now(), updated_at = now(), updated_by = $2
         WHERE folder_id IN (SELECT id FROM descendants) AND is_deleted = false AND title <> '${LegacyService.ZYRA_MEMORY_DOC_TITLE}'`,
        [folderId, uid]
      );
      await client.query(
        `${descendantsCte} UPDATE knowledge_files SET is_deleted = true, deleted_at = now()
         WHERE folder_id IN (SELECT id FROM descendants) AND is_deleted = false`,
        [folderId]
      );
      // The memory document was spared above, so it would now point at a deleted folder and appear in
      // no listing at all — kept but invisible is worse than a clear refusal. Re-home it to the root.
      await client.query(
        `${descendantsCte} UPDATE knowledge_documents
            SET folder_id = (SELECT id FROM knowledge_folders WHERE project_id = $2 AND is_root = true LIMIT 1),
                updated_at = now()
          WHERE folder_id IN (SELECT id FROM descendants) AND title = '${LegacyService.ZYRA_MEMORY_DOC_TITLE}'`,
        [folderId, projectId]
      );
    });

    // Storage cleanup runs after the DB commit and is best-effort: the soft-delete is the
    // source of truth, so a transient S3 failure here shouldn't surface as a failed delete.
    await Promise.all(
      filesToPurge.rows.map((row) =>
        this.storage
          .delete(row.storage_key)
          .catch((error) => this.logger.warn(`Failed to delete storage object ${row.storage_key}: ${error}`))
      )
    );

    await this.logProjectActivity(projectId, uid, "deleted", "knowledge_folder", folderId, folder.name, {});
    return { success: true };
  }

  async restoreKnowledgeFolder(projectId: string, userId: string | null | undefined, folderId: string) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    const role = await this.kbProjectRole(uid, projectId);
    this.kbRequireOwnerOrManager(role);
    // Restore resolves nothing first (a deleted row is invisible to kbFolder), so the uuid guard
    // has to sit here rather than in the resolver.
    if (!isUuid(folderId)) throw new NotFoundException({ error: "Folder not found" });
    const res = await this.db.query(
      "UPDATE knowledge_folders SET is_deleted = false, deleted_at = NULL, updated_by = $2, updated_at = now() WHERE id = $1 AND project_id = $3 RETURNING *",
      [folderId, uid, projectId]
    );
    if (!res.rows[0]) throw new NotFoundException({ error: "Folder not found" });
    await this.logProjectActivity(projectId, uid, "restored", "knowledge_folder", folderId, res.rows[0].name, {});
    return toCamel(res.rows[0]);
  }

  // Bundles a folder (and every non-deleted subfolder beneath it) into a zip: documents as
  // self-contained .html files (contentHtml, no external CSS dependency), files re-read from
  // storage under their original names. Folder structure is preserved as directories in the zip.
  async exportKnowledgeFolder(projectId: string, userId: string | null | undefined, folderId: string): Promise<{ buffer: Buffer; filename: string }> {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    const folder = await this.kbFolder(projectId, folderId);

    const descendants = await this.db.query<{ id: string; parent_folder_id: string | null; name: string }>(
      `WITH RECURSIVE descendants AS (
         SELECT id, parent_folder_id, name, 0 AS depth FROM knowledge_folders WHERE id = $1 AND is_deleted = false
         UNION ALL
         SELECT kf.id, kf.parent_folder_id, kf.name, d.depth + 1
         FROM knowledge_folders kf JOIN descendants d ON kf.parent_folder_id = d.id
         WHERE kf.is_deleted = false
       )
       SELECT id, parent_folder_id, name FROM descendants ORDER BY depth`,
      [folderId]
    );
    const folderIds = descendants.rows.map((row) => row.id);

    // Rows arrive parent-before-child (ORDER BY depth), so each parent's zip path is always
    // already resolved by the time its children are processed.
    const zipPathByFolderId = new Map<string, string>([[folderId, ""]]);
    for (const row of descendants.rows) {
      if (row.id === folderId) continue;
      const parentPath = zipPathByFolderId.get(row.parent_folder_id || "") ?? "";
      const segment = sanitizeZipEntryName(row.name);
      zipPathByFolderId.set(row.id, parentPath ? `${parentPath}/${segment}` : segment);
    }

    const [documents, files] = await Promise.all([
      this.db.query<{ folder_id: string; title: string; content_html: string | null }>(
        "SELECT folder_id, title, content_html FROM knowledge_documents WHERE folder_id = ANY($1::uuid[]) AND is_deleted = false",
        [folderIds]
      ),
      this.db.query<{ folder_id: string; original_file_name: string; storage_key: string }>(
        "SELECT folder_id, original_file_name, storage_key FROM knowledge_files WHERE folder_id = ANY($1::uuid[]) AND is_deleted = false",
        [folderIds]
      )
    ]);

    const archive = archiver("zip", { zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise<void>((resolve, reject) => {
      archive.on("end", () => resolve());
      archive.on("error", reject);
    });

    for (const doc of documents.rows) {
      const folderPath = zipPathByFolderId.get(doc.folder_id) || "";
      const entryName = `${sanitizeZipEntryName(doc.title || "Untitled")}.html`;
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(doc.title || "Untitled")}</title></head><body>${doc.content_html || ""}</body></html>`;
      archive.append(Buffer.from(html, "utf-8"), { name: folderPath ? `${folderPath}/${entryName}` : entryName });
    }
    for (const file of files.rows) {
      const folderPath = zipPathByFolderId.get(file.folder_id) || "";
      const entryName = sanitizeZipEntryName(file.original_file_name);
      // Best-effort per file: a storage object that's missing/unreachable (e.g. deleted out of
      // band from the DB row) shouldn't fail the whole export — skip just that file.
      try {
        const buffer = await this.storage.getBuffer(file.storage_key);
        archive.append(buffer, { name: folderPath ? `${folderPath}/${entryName}` : entryName });
      } catch (error) {
        this.logger.warn(`Skipping file in knowledge-base export, storage object unreadable (${file.storage_key}): ${error}`);
      }
    }

    await archive.finalize();
    await finished;

    return { buffer: Buffer.concat(chunks), filename: `${sanitizeZipEntryName(folder.is_root ? "Knowledge base" : folder.name)}.zip` };
  }

  async listKnowledgeFolderItems(projectId: string, userId: string | null | undefined, folderId: string, query: Body) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const folder = await this.kbFolder(projectId, folderId);
    const breadcrumb = await this.kbBreadcrumb(folderId);

    const [folders, documents, files] = await Promise.all([
      this.db.query(
        /*
         * Folder rows carry the size and the counts of everything BENEATH them, at every depth.
         *
         * Basecamp 10199231000 — "Folder size is not displayed in Knowledge Base even when documents
         * are present". This was a bare `SELECT kf.*`, so a folder row had no size at all and the
         * table's Size column rendered "—" for every folder.
         *
         * Recursive, because a size that stopped at direct children would under-report any folder whose
         * content sits in subfolders — the normal shape once a KB is organised. `file_bytes` is real
         * stored bytes from knowledge_files; documents are DB text with no file behind them, so they
         * are reported as a COUNT rather than folded into the byte figure, and the screen shows both.
         */
        `WITH RECURSIVE subtree AS (
           SELECT id FROM knowledge_folders WHERE parent_folder_id = $1 AND is_deleted = false
           UNION ALL
           SELECT kf.id FROM knowledge_folders kf JOIN subtree st ON kf.parent_folder_id = st.id
           WHERE kf.is_deleted = false
         ),
         roots AS (
           SELECT id FROM knowledge_folders WHERE parent_folder_id = $1 AND is_deleted = false
         ),
         descendants AS (
           -- Every (root, descendant-including-itself) pair, so each listed folder can be aggregated.
           SELECT r.id AS root_id, r.id AS node_id FROM roots r
           UNION ALL
           SELECT d.root_id, kf.id
           FROM knowledge_folders kf JOIN descendants d ON kf.parent_folder_id = d.node_id
           WHERE kf.is_deleted = false
         ),
         sizes AS (
           SELECT d.root_id,
                  COALESCE(SUM(f.file_size), 0)::bigint AS file_bytes,
                  COUNT(f.id)::int AS file_count
           FROM descendants d
           LEFT JOIN knowledge_files f ON f.folder_id = d.node_id AND f.is_deleted = false
           GROUP BY d.root_id
         ),
         docs AS (
           SELECT d.root_id, COUNT(kd.id)::int AS document_count
           FROM descendants d
           LEFT JOIN knowledge_documents kd ON kd.folder_id = d.node_id AND kd.is_deleted = false
           GROUP BY d.root_id
         )
         SELECT kf.*, u.name AS updated_by_name, u.email AS updated_by_email,
                COALESCE(sz.file_bytes, 0)::bigint AS file_bytes,
                COALESCE(sz.file_count, 0)::int AS file_count,
                COALESCE(dc.document_count, 0)::int AS document_count
         FROM knowledge_folders kf
         LEFT JOIN users u ON u.id = kf.updated_by
         LEFT JOIN sizes sz ON sz.root_id = kf.id
         LEFT JOIN docs dc ON dc.root_id = kf.id
         WHERE kf.parent_folder_id = $1 AND kf.is_deleted = false ORDER BY kf.name`,
        [folderId]
      ),
      this.db.query(
        `SELECT kd.*, u.name AS updated_by_name, u.email AS updated_by_email,
                COALESCE(NULLIF(TRIM(su.name), ''), su.email) AS synced_by_name
         FROM knowledge_documents kd
         LEFT JOIN users u ON u.id = kd.updated_by
         LEFT JOIN users su ON su.id = kd.source_synced_by
         WHERE kd.folder_id = $1 AND kd.is_deleted = false ORDER BY kd.updated_at DESC`,
        [folderId]
      ),
      this.db.query(
        `SELECT kfl.*, u.name AS updated_by_name, u.email AS updated_by_email
         FROM knowledge_files kfl LEFT JOIN users u ON u.id = kfl.uploaded_by
         WHERE kfl.folder_id = $1 AND kfl.is_deleted = false ORDER BY kfl.updated_at DESC`,
        [folderId]
      )
    ]);

    const items: Body[] = [
      ...folders.rows.map((row) => {
        const camelled = toCamel(row);
        // node-postgres returns bigint as a string to avoid precision loss; the byte total is far
        // below 2^53 so a Number is safe, and the client should not have to parse it.
        return Object.assign(camelled, {
          type: "folder",
          fileBytes: Number(camelled.fileBytes ?? 0),
          fileCount: Number(camelled.fileCount ?? 0),
          documentCount: Number(camelled.documentCount ?? 0)
        });
      }),
      ...documents.rows.map((row) => {
        const camelled = toCamel(row);
        delete camelled.searchVector;
        // A document has no file behind it, so its "size" is the byte length of the text it holds.
        // Reported as fileSize so the table's existing formatter renders it without a special case.
        return Object.assign(camelled, {
          type: "document",
          fileSize: Buffer.byteLength(String(row.content_text ?? ""), "utf8")
        });
      }),
      ...files.rows.map((row) => Object.assign(this.kbFileView(row), { type: "file" }))
    ];

    const search = String(query.search || "").trim().toLowerCase();
    const filtered = search ? items.filter((item) => String(item.name || item.title || "").toLowerCase().includes(search)) : items;

    return {
      folder: { ...toCamel(folder), breadcrumb },
      items: filtered,
      total: filtered.length
    };
  }

  async listKnowledgeDocuments(projectId: string, userId: string | null | undefined, query: Body) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const values: any[] = [projectId];
    const filters = ["project_id = $1", "is_deleted = false"];
    if (query.documentType) {
      values.push(String(query.documentType));
      filters.push(`document_type = $${values.length}`);
    }
    const res = await this.db.query(
      `SELECT ${LegacyService.KB_DOCUMENT_COLUMNS} FROM knowledge_documents WHERE ${filters.join(" AND ")} ORDER BY updated_at DESC LIMIT 200`,
      values
    );
    return { list: res.rows.map(toCamel), total: res.rowCount };
  }

  // Same limit the document editor enforces client-side before ever calling this endpoint —
  // repeated here because the API is reachable directly, bypassing that check entirely.
  private assertKnowledgeDocumentPayloadSize(body: Body) {
    const jsonSize = body.contentJson ? Buffer.byteLength(JSON.stringify(body.contentJson), "utf8") : 0;
    const htmlSize = body.contentHtml ? Buffer.byteLength(String(body.contentHtml), "utf8") : 0;
    const textSize = body.contentText ? Buffer.byteLength(String(body.contentText), "utf8") : 0;
    const size = jsonSize + htmlSize + textSize;
    if (size > LegacyService.KB_DOCUMENT_MAX_PAYLOAD_BYTES) {
      const limitMb = LegacyService.KB_DOCUMENT_MAX_PAYLOAD_BYTES / (1024 * 1024);
      throw new BadRequestException({
        error: `This document is over the ${limitMb}MB limit we currently support. Split it into smaller documents to save.`
      });
    }
  }

  async createKnowledgeDocument(projectId: string, userId: string | null | undefined, body: Body) {
    const uid = this.requireUser(userId);
    const project = await this.requireProjectAccess(uid, projectId);
    const title = String(body.title || "").trim();
    if (!title) throw new BadRequestException({ error: "Document title is required" });
    if (title.length > LegacyService.KB_DOCUMENT_TITLE_MAX_LENGTH) {
      throw new BadRequestException({ error: `Title must be at most ${LegacyService.KB_DOCUMENT_TITLE_MAX_LENGTH} characters` });
    }
    this.assertKnowledgeDocumentPayloadSize(body);
    const folderId = String(body.folderId || "");
    if (!folderId) throw new BadRequestException({ error: "folderId is required" });
    await this.kbFolder(projectId, folderId);

    const documentType = body.documentType || "general";
    const res = await this.db.query(
      `INSERT INTO knowledge_documents (organization_id, project_id, folder_id, title, content_json, content_html, content_text, document_type, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, 'draft', $9, $9) RETURNING ${LegacyService.KB_DOCUMENT_COLUMNS}`,
      [
        project.organization_id,
        projectId,
        folderId,
        title,
        body.contentJson ? JSON.stringify(body.contentJson) : null,
        body.contentHtml || null,
        body.contentText || null,
        documentType,
        uid
      ]
    );
    await this.logProjectActivity(projectId, uid, "created", "knowledge_document", res.rows[0].id, title, {});
    this.enqueueEmbedding(project.organization_id, projectId, "document", res.rows[0].id, "created");
    return toCamel(res.rows[0]);
  }

  private async kbDocument(projectId: string, documentId: string): Promise<Body> {
    if (!isUuid(documentId)) throw new NotFoundException({ error: "Document not found" });
    const res = await this.db.query(
      `SELECT ${LegacyService.KB_DOCUMENT_COLUMNS} FROM knowledge_documents WHERE id = $1 AND project_id = $2 AND is_deleted = false`,
      [documentId, projectId]
    );
    if (!res.rows[0]) throw new NotFoundException({ error: "Document not found" });
    return res.rows[0];
  }

  async getKnowledgeDocument(projectId: string, userId: string | null | undefined, documentId: string) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const doc = await this.kbDocument(projectId, documentId);
    const breadcrumb = await this.kbBreadcrumb(doc.folder_id);
    // Resolved separately rather than joined: KB_DOCUMENT_COLUMNS is shared with INSERT/UPDATE
    // RETURNING clauses where a join isn't available.
    const syncedByName = await this.kbSyncedByName(doc.source_synced_by);
    return { ...toCamel(doc), syncedByName, breadcrumb };
  }

  // Powers the Knowledge Base info-icon popover: this document's add/update timeline, 5 events per
  // page (newest first) so a ticket synced nightly for a year doesn't dump hundreds of rows into a
  // small popup. Only meaningful for a synced mirror, but reuses the same project-access +
  // existence check as every other KB document route rather than special-casing on source_provider.
  async getKnowledgeDocumentSyncEvents(projectId: string, userId: string | null | undefined, documentId: string, query: Body = {}) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    await this.kbDocument(projectId, documentId);
    const limit = pageNumber(query.limit, 5, 1, 20);
    const offset = pageNumber(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    return this.integrationSync.listSyncEventsForDocument(documentId, limit, offset);
  }

  // Display name for the person whose Sync click last rewrote a mirrored document.
  private async kbSyncedByName(userId: unknown): Promise<string | null> {
    if (!userId) return null;
    const res = await this.db
      .query<{ name: string | null }>("SELECT COALESCE(NULLIF(TRIM(name), ''), email) AS name FROM users WHERE id = $1", [userId])
      .catch(() => ({ rows: [] as Array<{ name: string | null }> }));
    return res.rows[0]?.name || null;
  }

  async updateKnowledgeDocument(projectId: string, userId: string | null | undefined, documentId: string, body: Body) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    const doc = await this.kbDocument(projectId, documentId);
    const role = await this.kbProjectRole(uid, projectId);
    this.kbRequireMutateAccess(role, doc.created_by, uid);
    // Provider-owned mirrors are rewritten wholesale by every sync, so an edit here would be
    // silently discarded later. Comments are the writable channel on these documents — they live
    // in knowledge_document_comments, untouched by sync. Enforced here and not only in the editor,
    // since the API is reachable directly.
    if (doc.is_read_only) {
      throw new BadRequestException({
        error: `"${doc.title}" is synced from ${doc.source_provider === "linear" ? "Linear" : "Jira"} and its body can't be edited — the next sync would overwrite your changes. Add a comment on the document instead.`
      });
    }

    const nextTitle = body.title !== undefined ? String(body.title).trim() : doc.title;
    // Renaming detaches the document from the agent: rememberZyraMemory and zyraMemoryText both look
    // it up BY TITLE, so the old memory becomes unreachable and a second, empty one starts.
    if (this.isZyraMemoryDocument(doc) && nextTitle !== doc.title) {
      throw new BadRequestException({
        error: `"${LegacyService.ZYRA_MEMORY_DOC_TITLE}" is managed by Zyra and can't be renamed — Zyra finds its memory by this title.`
      });
    }
    const nextJson = body.contentJson !== undefined ? JSON.stringify(body.contentJson) : doc.content_json ? JSON.stringify(doc.content_json) : null;
    const nextHtml = body.contentHtml !== undefined ? body.contentHtml : doc.content_html;
    const nextText = body.contentText !== undefined ? body.contentText : doc.content_text;

    if (!nextTitle && !String(nextText || "").trim()) {
      throw new BadRequestException({ error: "A document needs a title or some content — it can't be saved blank." });
    }
    if (nextTitle.length > LegacyService.KB_DOCUMENT_TITLE_MAX_LENGTH) {
      throw new BadRequestException({ error: `Title must be at most ${LegacyService.KB_DOCUMENT_TITLE_MAX_LENGTH} characters` });
    }
    this.assertKnowledgeDocumentPayloadSize(body);

    const contentChanged =
      nextTitle !== doc.title || nextHtml !== doc.content_html || nextText !== doc.content_text;

    if (contentChanged) {
      const latest = await this.db.query<{ created_at: string }>(
        "SELECT created_at FROM knowledge_document_versions WHERE document_id = $1 ORDER BY version_number DESC LIMIT 1",
        [documentId]
      );
      const staleMinutes = LegacyService.KB_VERSION_SNAPSHOT_MINUTES;
      const isStale =
        !latest.rows[0] ||
        Date.now() - new Date(latest.rows[0].created_at).getTime() > staleMinutes * 60 * 1000;
      if (isStale) {
        // Serialised per document, and sharing its lock key with restoreKnowledgeDocumentVersion —
        // MAX(version_number)+1 alone lets a concurrent edit and a concurrent restore compute the
        // same next number, and the table has no unique constraint to reject the duplicate insert.
        await this.db.transaction(async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`kb-doc-version:${documentId}`]);
          const nextVersion = await client.query<{ max: number }>(
            "SELECT COALESCE(MAX(version_number), 0) + 1 AS max FROM knowledge_document_versions WHERE document_id = $1",
            [documentId]
          );
          await client.query(
            `INSERT INTO knowledge_document_versions (document_id, version_number, title, content_json, content_html, content_text, created_by)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
            [documentId, nextVersion.rows[0].max, doc.title, doc.content_json ? JSON.stringify(doc.content_json) : null, doc.content_html, doc.content_text, uid]
          );
        });
      }
    }

    let nextStatus = doc.status;
    let reviewedBy = doc.reviewed_by;
    let reviewedAt = doc.reviewed_at;
    if (doc.document_type === "ai_memory") {
      if (doc.status === "approved" && contentChanged) {
        nextStatus = "draft";
        reviewedBy = null;
        reviewedAt = null;
      }
      // status transitions for ai_memory only happen via approve/reject endpoints
    } else if (body.status !== undefined) {
      nextStatus = String(body.status);
    }

    const res = await this.db.query(
      `UPDATE knowledge_documents SET title = $2, content_json = $3::jsonb, content_html = $4, content_text = $5,
       document_type = COALESCE($6, document_type), status = $7, reviewed_by = $8, reviewed_at = $9,
       updated_by = $10, updated_at = now()
       WHERE id = $1 RETURNING ${LegacyService.KB_DOCUMENT_COLUMNS}`,
      [documentId, nextTitle, nextJson, nextHtml, nextText, body.documentType || null, nextStatus, reviewedBy, reviewedAt, uid]
    );
    await this.logProjectActivity(projectId, uid, "updated", "knowledge_document", documentId, nextTitle, {});
    if (contentChanged) this.enqueueEmbedding(res.rows[0].organization_id, projectId, "document", documentId, "updated");
    return toCamel(res.rows[0]);
  }

  async moveKnowledgeDocument(projectId: string, userId: string | null | undefined, documentId: string, body: Body) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    const doc = await this.kbDocument(projectId, documentId);
    const role = await this.kbProjectRole(uid, projectId);
    this.kbRequireMutateAccess(role, doc.created_by, uid);
    const folderId = String(body.folderId || "");
    if (!folderId) throw new BadRequestException({ error: "folderId is required" });
    await this.kbFolder(projectId, folderId);

    const res = await this.db.query(
      `UPDATE knowledge_documents SET folder_id = $2, updated_by = $3, updated_at = now()
       WHERE id = $1 RETURNING ${LegacyService.KB_DOCUMENT_COLUMNS}`,
      [documentId, folderId, uid]
    );
    await this.logProjectActivity(projectId, uid, "moved", "knowledge_document", documentId, res.rows[0].title, {});
    return toCamel(res.rows[0]);
  }

  async duplicateKnowledgeDocument(projectId: string, userId: string | null | undefined, documentId: string) {
    const uid = this.requireUser(userId);
    const project = await this.requireProjectAccess(uid, projectId);
    const doc = await this.kbDocument(projectId, documentId);
    const res = await this.db.query(
      `INSERT INTO knowledge_documents (organization_id, project_id, folder_id, title, content_json, content_html, content_text, document_type, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, 'draft', $9, $9) RETURNING ${LegacyService.KB_DOCUMENT_COLUMNS}`,
      [
        project.organization_id,
        projectId,
        doc.folder_id,
        `${doc.title} (copy)`,
        doc.content_json ? JSON.stringify(doc.content_json) : null,
        doc.content_html,
        doc.content_text,
        doc.document_type,
        uid
      ]
    );
    await this.logProjectActivity(projectId, uid, "duplicated", "knowledge_document", res.rows[0].id, res.rows[0].title, {});
    this.enqueueEmbedding(project.organization_id, projectId, "document", res.rows[0].id, "created");
    return toCamel(res.rows[0]);
  }

  /** True for the agent-managed memory document, which users may read but not delete or rename. */
  private isZyraMemoryDocument(doc: { title?: unknown }): boolean {
    return String(doc?.title ?? "").trim() === LegacyService.ZYRA_MEMORY_DOC_TITLE;
  }

  async deleteKnowledgeDocument(projectId: string, userId: string | null | undefined, documentId: string) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    const doc = await this.kbDocument(projectId, documentId);
    const role = await this.kbProjectRole(uid, projectId);
    this.kbRequireMutateAccess(role, doc.created_by, uid);
    if (this.isZyraMemoryDocument(doc)) {
      throw new BadRequestException({
        error: `"${LegacyService.ZYRA_MEMORY_DOC_TITLE}" is managed by Zyra and can't be deleted — it holds everything Zyra has learned about this project. To clear it, reset Zyra's memory from the agent's settings.`
      });
    }
    await this.db.query(
      "UPDATE knowledge_documents SET is_deleted = true, deleted_at = now(), updated_by = $2, updated_at = now() WHERE id = $1",
      [documentId, uid]
    );
    await this.logProjectActivity(projectId, uid, "deleted", "knowledge_document", documentId, doc.title, {});
    return { success: true };
  }

  async restoreKnowledgeDocument(projectId: string, userId: string | null | undefined, documentId: string) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    const role = await this.kbProjectRole(uid, projectId);
    this.kbRequireOwnerOrManager(role);
    if (!isUuid(documentId)) throw new NotFoundException({ error: "Document not found" });
    const res = await this.db.query(
      `UPDATE knowledge_documents SET is_deleted = false, deleted_at = NULL, updated_by = $2, updated_at = now()
       WHERE id = $1 AND project_id = $3 RETURNING ${LegacyService.KB_DOCUMENT_COLUMNS}`,
      [documentId, uid, projectId]
    );
    if (!res.rows[0]) throw new NotFoundException({ error: "Document not found" });
    await this.logProjectActivity(projectId, uid, "restored", "knowledge_document", documentId, res.rows[0].title, {});
    return toCamel(res.rows[0]);
  }

  // ─── Knowledge Base v2: document comments ──────────────────────────────────
  // Google-Docs-shaped discussion on a document: one level of threading (root + replies),
  // resolvable per thread, optionally anchored to a quoted passage. Comments are stored apart
  // from the body, which is what lets them work on a read-only provider mirror whose body is
  // rewritten by every sync.

  private static readonly KB_COMMENT_COLUMNS = `c.id, c.document_id, c.parent_comment_id, c.author_id, c.body,
    c.anchor_text, c.anchor_start, c.anchor_end, c.is_resolved, c.resolved_by, c.resolved_at,
    c.created_at, c.updated_at`;

  private kbCommentView(row: Body): Body {
    return {
      id: String(row.id),
      documentId: String(row.document_id),
      parentCommentId: row.parent_comment_id ? String(row.parent_comment_id) : null,
      authorId: row.author_id ? String(row.author_id) : null,
      authorName: row.author_name ? String(row.author_name) : "Unknown",
      body: String(row.body || ""),
      anchorText: row.anchor_text ? String(row.anchor_text) : null,
      anchorStart: row.anchor_start === null || row.anchor_start === undefined ? null : Number(row.anchor_start),
      anchorEnd: row.anchor_end === null || row.anchor_end === undefined ? null : Number(row.anchor_end),
      isResolved: !!row.is_resolved,
      resolvedBy: row.resolved_by ? String(row.resolved_by) : null,
      resolvedByName: row.resolved_by_name ? String(row.resolved_by_name) : null,
      resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      replies: [] as Body[]
    };
  }

  async listKnowledgeDocumentComments(projectId: string, userId: string | null | undefined, documentId: string) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    await this.kbDocument(projectId, documentId);

    const res = await this.db.query(
      `SELECT ${LegacyService.KB_COMMENT_COLUMNS},
              COALESCE(NULLIF(TRIM(a.name), ''), a.email) AS author_name,
              COALESCE(NULLIF(TRIM(r.name), ''), r.email) AS resolved_by_name
       FROM knowledge_document_comments c
       LEFT JOIN users a ON a.id = c.author_id
       LEFT JOIN users r ON r.id = c.resolved_by
       WHERE c.document_id = $1 AND c.is_deleted = false
       ORDER BY c.created_at ASC`,
      [documentId]
    );

    // Assembled into threads here rather than with a recursive CTE: nesting is one level deep, so
    // a single ordered pass is both simpler and cheaper.
    const roots: Body[] = [];
    const byId = new Map<string, Body>();
    for (const row of res.rows) {
      const view = this.kbCommentView(row);
      byId.set(view.id, view);
      if (!view.parentCommentId) roots.push(view);
    }
    for (const row of res.rows) {
      const parentId = row.parent_comment_id ? String(row.parent_comment_id) : null;
      if (!parentId) continue;
      // A reply whose root was deleted has nowhere to hang; promoting it would silently reorder
      // the conversation, so it is dropped from the view (the row itself is untouched).
      byId.get(parentId)?.replies.push(byId.get(String(row.id))!);
    }

    const openCount = roots.filter((thread) => !thread.isResolved).length;
    return { list: roots, total: roots.length, openCount };
  }

  async createKnowledgeDocumentComment(projectId: string, userId: string | null | undefined, documentId: string, body: Body) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    const doc = await this.kbDocument(projectId, documentId);

    const text = String(body?.body ?? "").trim();
    if (!text) throw new BadRequestException({ error: "Comment cannot be empty." });
    if (text.length > 10000) throw new BadRequestException({ error: "Comment is too long (10,000 character limit)." });

    const parentCommentId = body?.parentCommentId ? String(body.parentCommentId) : null;
    if (parentCommentId) {
      if (!isUuid(parentCommentId))
        throw new NotFoundException({ error: "The comment you're replying to no longer exists." });
      const parent = await this.db.query<{ id: string; parent_comment_id: string | null }>(
        "SELECT id, parent_comment_id FROM knowledge_document_comments WHERE id = $1 AND document_id = $2 AND is_deleted = false",
        [parentCommentId, documentId]
      );
      if (!parent.rows[0]) throw new NotFoundException({ error: "The comment you're replying to no longer exists." });
      // Threads stay one level deep — a reply to a reply joins the same thread instead.
      if (parent.rows[0].parent_comment_id) {
        throw new BadRequestException({ error: "Reply to the top comment of the thread instead of to another reply." });
      }
    }

    // Only a thread root can carry an anchor; the CHECK in V73 enforces the same shape.
    const anchorText = !parentCommentId && body?.anchorText ? String(body.anchorText).slice(0, 2000) : null;
    const anchorStart = anchorText && Number.isFinite(Number(body?.anchorStart)) ? Math.max(0, Number(body.anchorStart)) : null;
    const anchorEnd = anchorText && Number.isFinite(Number(body?.anchorEnd)) ? Math.max(0, Number(body.anchorEnd)) : null;

    const res = await this.db.query(
      `INSERT INTO knowledge_document_comments
         (organization_id, project_id, document_id, parent_comment_id, author_id, body, anchor_text, anchor_start, anchor_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [doc.organization_id, projectId, documentId, parentCommentId, uid, text, anchorText, anchorStart, anchorEnd]
    );
    await this.logProjectActivity(projectId, uid, parentCommentId ? "replied" : "commented", "knowledge_document", documentId, doc.title, {
      commentId: res.rows[0].id
    });
    return this.getKnowledgeDocumentComment(projectId, res.rows[0].id);
  }

  private async getKnowledgeDocumentComment(projectId: string, commentId: string): Promise<Body> {
    const res = await this.db.query(
      `SELECT ${LegacyService.KB_COMMENT_COLUMNS},
              COALESCE(NULLIF(TRIM(a.name), ''), a.email) AS author_name,
              COALESCE(NULLIF(TRIM(r.name), ''), r.email) AS resolved_by_name
       FROM knowledge_document_comments c
       LEFT JOIN users a ON a.id = c.author_id
       LEFT JOIN users r ON r.id = c.resolved_by
       WHERE c.id = $1 AND c.project_id = $2 AND c.is_deleted = false`,
      [commentId, projectId]
    );
    if (!res.rows[0]) throw new NotFoundException({ error: "Comment not found" });
    return this.kbCommentView(res.rows[0]);
  }

  async updateKnowledgeDocumentComment(projectId: string, userId: string | null | undefined, commentId: string, body: Body) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    if (!isUuid(commentId)) throw new NotFoundException({ error: "Comment not found" });
    const existing = await this.db.query<{ id: string; author_id: string | null; parent_comment_id: string | null; document_id: string }>(
      "SELECT id, author_id, parent_comment_id, document_id FROM knowledge_document_comments WHERE id = $1 AND project_id = $2 AND is_deleted = false",
      [commentId, projectId]
    );
    const comment = existing.rows[0];
    if (!comment) throw new NotFoundException({ error: "Comment not found" });
    const role = await this.kbProjectRole(uid, projectId);

    // Editing wording is the author's alone — a manager rewriting someone else's comment would
    // misattribute it. Resolving is a triage action, so it follows the usual KB mutate rule.
    if (body?.body !== undefined) {
      if (comment.author_id !== uid) throw new ForbiddenException({ error: "You can only edit your own comments" });
      const text = String(body.body).trim();
      if (!text) throw new BadRequestException({ error: "Comment cannot be empty." });
      if (text.length > 10000) throw new BadRequestException({ error: "Comment is too long (10,000 character limit)." });
      await this.db.query("UPDATE knowledge_document_comments SET body = $2, updated_at = now() WHERE id = $1", [commentId, text]);
    }

    if (body?.isResolved !== undefined) {
      if (comment.parent_comment_id) throw new BadRequestException({ error: "Resolve the whole thread from its top comment." });
      this.kbRequireMutateAccess(role, comment.author_id, uid);
      const resolved = !!body.isResolved;
      await this.db.query(
        `UPDATE knowledge_document_comments
         SET is_resolved = $2, resolved_by = $3, resolved_at = $4, updated_at = now()
         WHERE id = $1`,
        [commentId, resolved, resolved ? uid : null, resolved ? new Date().toISOString() : null]
      );
    }

    return this.getKnowledgeDocumentComment(projectId, commentId);
  }

  async deleteKnowledgeDocumentComment(projectId: string, userId: string | null | undefined, commentId: string) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    if (!isUuid(commentId)) throw new NotFoundException({ error: "Comment not found" });
    const existing = await this.db.query<{ id: string; author_id: string | null }>(
      "SELECT id, author_id FROM knowledge_document_comments WHERE id = $1 AND project_id = $2 AND is_deleted = false",
      [commentId, projectId]
    );
    const comment = existing.rows[0];
    if (!comment) throw new NotFoundException({ error: "Comment not found" });
    const role = await this.kbProjectRole(uid, projectId);
    this.kbRequireMutateAccess(role, comment.author_id, uid);

    // Soft delete, and take the thread's replies with it so no orphans are left behind.
    await this.db.query(
      `UPDATE knowledge_document_comments
       SET is_deleted = true, deleted_at = now(), updated_at = now()
       WHERE id = $1 OR parent_comment_id = $1`,
      [commentId]
    );
    return { success: true };
  }

  // ─── Knowledge Base v2: files ──────────────────────────────────────────────

  static readonly KB_MAX_UPLOAD_SIZE = Number(process.env.MAX_UPLOAD_SIZE) || 100 * 1024 * 1024;
  // Archives (zip) and executables (exe) are deliberately excluded — a zip can hide anything,
  // including an executable, past this extension check.
  static readonly KB_ALLOWED_EXTENSIONS = new Set([
    "png", "jpg", "jpeg", "webp", "svg",
    "pdf", "doc", "docx", "txt", "md",
    "xls", "xlsx", "csv",
    "ppt", "pptx",
    "js", "ts", "java", "py", "json", "xml", "yaml", "yml", "sql", "html", "css",
    "mp3", "wav", "m4a",
    "mp4", "mov", "webm"
  ]);
  // Extensions we can read as plain UTF-8 text without any parsing library.
  static readonly KB_PLAINTEXT_EXTENSIONS = new Set([
    "txt", "md", "csv", "json", "xml", "yaml", "yml", "sql", "html", "css", "js", "ts", "java", "py"
  ]);
  // exceljs only reads the Open XML .xlsx format — legacy binary .xls is not supported, the same
  // limitation mammoth has for .doc below. .xls stays in KB_ALLOWED_EXTENSIONS so the upload still
  // succeeds; it just contributes no extracted text to Zyra's context.
  static readonly KB_SPREADSHEET_EXTENSIONS = new Set(["xlsx"]);
  static readonly KB_PDF_EXTENSIONS = new Set(["pdf"]);
  // mammoth only reads the Open XML .docx format — legacy binary .doc is not supported.
  static readonly KB_DOCX_EXTENSIONS = new Set(["docx"]);
  // webp/svg are excluded: the underlying OCR engine's image decoder reliably supports
  // only png/jpg/bmp, so webp would silently produce no text.
  static readonly KB_IMAGE_OCR_EXTENSIONS = new Set(["png", "jpg", "jpeg"]);
  // Whisper accepts these containers directly (audio track only, no ffmpeg needed for the
  // video ones) — .mov is intentionally excluded, OpenAI's endpoint doesn't accept it.
  static readonly KB_AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a"]);
  static readonly KB_TRANSCRIBABLE_VIDEO_EXTENSIONS = new Set(["mp4", "webm"]);
  static readonly KB_EXTRACTED_TEXT_LIMIT = 20000;
  static readonly KB_TESSDATA_PATH = process.env.TESSDATA_PATH || "/app/tessdata";

  // exceljs models a row as a sparse array, so cells are read positionally up to the sheet's column
  // count rather than by iterating only the cells that exist — otherwise a row with a gap in the
  // middle would shift every later column one to the left.
  private static worksheetToCsv(sheet: ExcelJS.Worksheet): string {
    const lines: string[] = [];
    sheet.eachRow({ includeEmpty: true }, (row) => {
      const cells: string[] = [];
      for (let column = 1; column <= sheet.columnCount; column += 1) {
        // `.text` flattens every shape a cell value can take — rich text, a hyperlink, a formula's
        // cached result, a date — into the string a reader would see in Excel.
        const text = row.getCell(column).text ?? "";
        cells.push(/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
      }
      lines.push(cells.join(","));
    });
    return lines.join("\n");
  }

  // Best-effort text extraction so Zyra's knowledge-base context can include file contents,
  // not just file names. Runs synchronously in the upload request — everything here is local
  // CPU/WASM work with no network call. Audio/video transcription is handled separately
  // (transcribeKnowledgeFile) since it calls out to an AI provider and can take a while.
  private async extractKnowledgeFileText(buffer: Buffer, ext: string): Promise<string | null> {
    try {
      if (LegacyService.KB_PLAINTEXT_EXTENSIONS.has(ext)) {
        return buffer.toString("utf8").slice(0, LegacyService.KB_EXTRACTED_TEXT_LIMIT);
      }
      if (LegacyService.KB_SPREADSHEET_EXTENSIONS.has(ext)) {
        const workbook = new ExcelJS.Workbook();
        // exceljs's own index.d.ts is a module, so its unwrapped `declare interface Buffer
        // extends ArrayBuffer {}` fallback (for consumers without @types/node) shadows the
        // real Buffer only inside that file — `load()`'s parameter type is that local,
        // permanently-incompatible stub, not Node's Buffer, so no cast to `Buffer` can ever
        // satisfy it. `any` is required to bypass the structural check entirely.
        await workbook.xlsx.load(buffer as any);
        const text = workbook.worksheets
          .map((sheet) => `Sheet: ${sheet.name}\n${LegacyService.worksheetToCsv(sheet)}`)
          .join("\n\n");
        return text.slice(0, LegacyService.KB_EXTRACTED_TEXT_LIMIT);
      }
      if (LegacyService.KB_PDF_EXTENSIONS.has(ext)) {
        const data = await pdfParse(buffer);
        return String(data.text || "").slice(0, LegacyService.KB_EXTRACTED_TEXT_LIMIT);
      }
      if (LegacyService.KB_DOCX_EXTENSIONS.has(ext)) {
        const result = await mammoth.extractRawText({ buffer });
        return String(result.value || "").slice(0, LegacyService.KB_EXTRACTED_TEXT_LIMIT);
      }
      if (LegacyService.KB_IMAGE_OCR_EXTENSIONS.has(ext)) {
        return await this.ocrImageText(buffer);
      }
    } catch (err) {
      this.logger.warn(`Knowledge-base text extraction failed for .${ext} file: ${err instanceof Error ? err.message : err}`);
    }
    return null;
  }

  // OCR reads the English language model baked into the image at build time (see Dockerfile)
  // so it works fully offline. Falls back to null (no extractable text) if that data isn't
  // present — e.g. running outside the built container image.
  private async ocrImageText(buffer: Buffer): Promise<string | null> {
    if (!fs.existsSync(path.join(LegacyService.KB_TESSDATA_PATH, "eng.traineddata.gz"))) {
      this.logger.warn(`OCR skipped — no tessdata found at ${LegacyService.KB_TESSDATA_PATH}`);
      return null;
    }
    /*
     * errorHandler is not optional here, despite the try/catch around every caller.
     *
     * tesseract.js's worker message handler does `if (errorHandler) errorHandler(data); else throw
     * Error(data)` (createWorker.js). That throw happens inside the worker's message callback, not
     * inside the promise recognize() returns — so it lands as an uncaught exception and takes the
     * whole Node process down. An image libpng cannot decode is enough to trigger it, which made
     * uploading one slightly-corrupt PNG to a knowledge base a way for any project member to
     * restart the API for everybody.
     *
     * With a handler installed, the same failure only rejects recognize(), which the caller's catch
     * already turns into "no extractable text".
     */
    const worker = await createWorker("eng", 1, {
      langPath: LegacyService.KB_TESSDATA_PATH,
      cachePath: LegacyService.KB_TESSDATA_PATH,
      gzip: true,
      errorHandler: (error: unknown) => {
        this.logger.warn(`OCR worker reported an error: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    try {
      const { data } = await worker.recognize(buffer);
      return String(data.text || "").trim().slice(0, LegacyService.KB_EXTRACTED_TEXT_LIMIT) || null;
    } finally {
      await worker.terminate();
    }
  }

  // Async speech-to-text for uploaded audio/video files, fired-and-forgotten from
  // uploadKnowledgeFiles (mirrors the processZyraTask pattern used for AI task generation)
  // so a multi-minute meeting recording doesn't block the upload HTTP response. Only attempted
  // when the project has an OpenAI key allocated — no other provider offers a compatible
  // transcription endpoint we can safely assume the shape of.
  private async transcribeKnowledgeFile(projectId: string, fileId: string, buffer: Buffer, ext: string, mimeType: string, fileName: string): Promise<void> {
    try {
      const project = await this.db.query<{ organization_id: string }>("SELECT organization_id FROM projects WHERE id = $1", [projectId]);
      const allocation = await this.zyraAiAllocation(projectId);
      const key = allocation.key;
      if (!key || String(key.provider || "").toLowerCase() !== "openai") {
        await this.db.query("UPDATE knowledge_files SET extraction_status = 'unsupported' WHERE id = $1", [fileId]);
        return;
      }
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(buffer)], { type: mimeType || "application/octet-stream" }), fileName);
      form.append("model", "whisper-1");
      const authHeader = String(key.auth_header_name || "Authorization");
      const scheme = String(key.auth_scheme || "Bearer").trim();
      const headers: Record<string, string> = {};
      headers[authHeader] = scheme ? `${scheme} ${key.api_key}` : String(key.api_key);
      const res = await fetch(normalizeAudioTranscriptionsUrl(key.base_url), { method: "POST", headers, body: form });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({} as Body)) as Body;
        const rawMessage = String(errBody.error?.message || errBody.error || res.status);
        throw new Error(rawMessage);
      }
      const data = await res.json() as Body;
      const text = String(data.text || "").trim().slice(0, LegacyService.KB_EXTRACTED_TEXT_LIMIT);
      await this.db.query(
        "UPDATE knowledge_files SET extracted_text = $2, extraction_status = 'ready', updated_at = now() WHERE id = $1",
        [fileId, text || null]
      );
      if (text) this.enqueueEmbedding(project.rows[0]?.organization_id, projectId, "file", fileId, "transcribed");
    } catch (err) {
      this.logger.warn(`Knowledge-base transcription failed for file ${fileId}: ${err instanceof Error ? err.message : err}`);
      await this.db.query("UPDATE knowledge_files SET extraction_status = 'failed', updated_at = now() WHERE id = $1", [fileId]).catch(() => undefined);
    }
  }

  /**
   * A knowledge file as it goes to a client, with the storage key removed.
   *
   * storage_key is the object's address inside the bucket. Handing it out contradicts the rule
   * getAccessUrl states for itself ("Never expose storage_key/paths to the client directly") and
   * undermines the download route's whole purpose: every read is supposed to pass through an
   * access check first, and a caller holding the key can address the object without one wherever
   * the bucket is reachable. file_name is dropped with it — it is the generated basename of that
   * same key, not a name any user chose (original_file_name is the one the UI shows).
   */
  private kbFileView(row: Body): Body {
    const camelled = toCamel(row);
    delete camelled.storageKey;
    delete camelled.fileName;
    return camelled;
  }

  private async kbFile(projectId: string, fileId: string): Promise<Body> {
    if (!isUuid(fileId)) throw new NotFoundException({ error: "File not found" });
    const res = await this.db.query(
      "SELECT * FROM knowledge_files WHERE id = $1 AND project_id = $2 AND is_deleted = false",
      [fileId, projectId]
    );
    if (!res.rows[0]) throw new NotFoundException({ error: "File not found" });
    return res.rows[0];
  }

  private async kbUniqueFileName(folderId: string, desiredName: string): Promise<string> {
    const ext = path.extname(desiredName);
    const base = path.basename(desiredName, ext);
    const existing = await this.db.query<{ original_file_name: string }>(
      "SELECT original_file_name FROM knowledge_files WHERE folder_id = $1 AND is_deleted = false",
      [folderId]
    );
    const taken = new Set(existing.rows.map((row) => row.original_file_name));
    if (!taken.has(desiredName)) return desiredName;
    let i = 1;
    while (taken.has(`${base} (${i})${ext}`)) i += 1;
    return `${base} (${i})${ext}`;
  }

  async uploadKnowledgeFiles(
    projectId: string,
    userId: string | null | undefined,
    folderId: string,
    files: Array<{ buffer: Buffer; originalname: string; mimetype: string; size: number }>
  ) {
    const uid = this.requireUser(userId);
    const project = await this.requireProjectAccess(uid, projectId);
    if (!folderId) throw new BadRequestException({ error: "folderId is required" });
    await this.kbFolder(projectId, folderId);
    if (!files || files.length === 0) throw new BadRequestException({ error: "No files were uploaded" });
    await this.planLimits.assertStorageAvailable(
      project.organization_id,
      files.reduce((sum, file) => sum + file.size, 0)
    );

    // Files are held in memory (never touch disk) until the whole batch passes validation,
    // so a single unsupported file rejects the batch atomically with nothing left behind —
    // this holds regardless of storage backend (local disk or S3-compatible).
    const invalid = files.find((file) => !LegacyService.KB_ALLOWED_EXTENSIONS.has(path.extname(file.originalname).replace(/^\./, "").toLowerCase()));
    if (invalid) {
      throw new BadRequestException({ error: `This file type is not supported: ${invalid.originalname}` });
    }

    const created: Body[] = [];
    for (const file of files) {
      const ext = path.extname(file.originalname).replace(/^\./, "").toLowerCase();
      const originalFileName = await this.kbUniqueFileName(folderId, file.originalname);
      const storageKey = `knowledge-base/${project.organization_id}/${projectId}/${randomUUID()}${ext ? `.${ext}` : ""}`;
      await this.storage.put(storageKey, file.buffer, file.mimetype);
      // Audio/video transcription is slow (calls an external AI provider) and shouldn't block
      // the upload response — it's kicked off after insert, below, and fills in extracted_text
      // asynchronously. Everything else extracts synchronously (local CPU/WASM work only).
      const isTranscribable = LegacyService.KB_AUDIO_EXTENSIONS.has(ext) || LegacyService.KB_TRANSCRIBABLE_VIDEO_EXTENSIONS.has(ext);
      const extractedText = isTranscribable ? null : await this.extractKnowledgeFileText(file.buffer, ext);
      const extractionStatus = isTranscribable ? "pending" : null;
      const res = await this.db.query(
        `INSERT INTO knowledge_files (organization_id, project_id, folder_id, file_name, original_file_name, mime_type, file_extension, file_size, storage_key, uploaded_by, extracted_text, extraction_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [project.organization_id, projectId, folderId, path.basename(storageKey), originalFileName, file.mimetype, ext, file.size, storageKey, uid, extractedText, extractionStatus]
      );
      created.push(this.kbFileView(res.rows[0]));
      await this.logProjectActivity(projectId, uid, "uploaded", "knowledge_file", res.rows[0].id, originalFileName, {});
      if (isTranscribable) {
        // Embedding is enqueued once the transcript lands (transcribeKnowledgeFile), not here —
        // there's no content yet for audio/video at upload time.
        void this.transcribeKnowledgeFile(projectId, res.rows[0].id, file.buffer, ext, file.mimetype, originalFileName).catch(() => undefined);
      } else {
        this.enqueueEmbedding(project.organization_id, projectId, "file", res.rows[0].id, "created");
      }
    }
    return { list: created, total: created.length };
  }

  async getKnowledgeFile(projectId: string, userId: string | null | undefined, fileId: string) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const file = await this.kbFile(projectId, fileId);
    const breadcrumb = await this.kbBreadcrumb(file.folder_id);
    return { ...this.kbFileView(file), breadcrumb };
  }

  async updateKnowledgeFile(projectId: string, userId: string | null | undefined, fileId: string, body: Body) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    const file = await this.kbFile(projectId, fileId);
    const role = await this.kbProjectRole(uid, projectId);
    this.kbRequireMutateAccess(role, file.uploaded_by, uid);

    const nextName = body.originalFileName ? String(body.originalFileName).trim() : file.original_file_name;
    const res = await this.db.query(
      "UPDATE knowledge_files SET original_file_name = $2, updated_at = now() WHERE id = $1 RETURNING *",
      [fileId, nextName]
    );
    await this.logProjectActivity(projectId, uid, "renamed", "knowledge_file", fileId, nextName, {});
    return this.kbFileView(res.rows[0]);
  }

  async moveKnowledgeFile(projectId: string, userId: string | null | undefined, fileId: string, body: Body) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    const file = await this.kbFile(projectId, fileId);
    const role = await this.kbProjectRole(uid, projectId);
    this.kbRequireMutateAccess(role, file.uploaded_by, uid);
    const folderId = String(body.folderId || "");
    if (!folderId) throw new BadRequestException({ error: "folderId is required" });
    await this.kbFolder(projectId, folderId);

    const res = await this.db.query(
      "UPDATE knowledge_files SET folder_id = $2, updated_at = now() WHERE id = $1 RETURNING *",
      [fileId, folderId]
    );
    await this.logProjectActivity(projectId, uid, "moved", "knowledge_file", fileId, res.rows[0].original_file_name, {});
    return this.kbFileView(res.rows[0]);
  }

  async deleteKnowledgeFile(projectId: string, userId: string | null | undefined, fileId: string) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    const file = await this.kbFile(projectId, fileId);
    const role = await this.kbProjectRole(uid, projectId);
    this.kbRequireMutateAccess(role, file.uploaded_by, uid);
    await this.db.query("UPDATE knowledge_files SET is_deleted = true, deleted_at = now(), updated_at = now() WHERE id = $1", [fileId]);
    // Best-effort: the soft-delete is the source of truth, so a transient S3 failure here
    // shouldn't surface as a failed delete.
    await this.storage
      .delete(file.storage_key)
      .catch((error) => this.logger.warn(`Failed to delete storage object ${file.storage_key}: ${error}`));
    await this.logProjectActivity(projectId, uid, "deleted", "knowledge_file", fileId, file.original_file_name, {});
    return { success: true };
  }

  async restoreKnowledgeFile(projectId: string, userId: string | null | undefined, fileId: string) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    const role = await this.kbProjectRole(uid, projectId);
    this.kbRequireOwnerOrManager(role);
    if (!isUuid(fileId)) throw new NotFoundException({ error: "File not found" });
    const res = await this.db.query(
      "UPDATE knowledge_files SET is_deleted = false, deleted_at = NULL, updated_at = now() WHERE id = $1 AND project_id = $2 RETURNING *",
      [fileId, projectId]
    );
    if (!res.rows[0]) throw new NotFoundException({ error: "File not found" });
    await this.logProjectActivity(projectId, uid, "restored", "knowledge_file", fileId, res.rows[0].original_file_name, {});
    return this.kbFileView(res.rows[0]);
  }

  // Resolves how to serve a file's bytes after the caller's own access check has passed:
  // a short-lived presigned redirect URL when storage is S3-compatible, or a local path to
  // stream when storage is local disk. Never expose storage_key/paths to the client directly.
  async getKnowledgeFileAccess(projectId: string, userId: string | null | undefined, fileId: string, inline: boolean) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const file = await this.kbFile(projectId, fileId);
    if (!file.storage_key || !(await this.storage.exists(file.storage_key))) {
      throw new NotFoundException({ error: "File content is not available" });
    }
    const mimeType = file.mime_type || "application/octet-stream";
    const ext = String(file.file_extension || "").toLowerCase().replace(/^\./, "");
    // Plaintext previews are fetched client-side with credentials to our own API; streaming them
    // directly (instead of redirecting to a presigned URL) avoids needing the storage bucket's
    // CORS policy to allow credentialed cross-origin requests.
    if (inline && LegacyService.KB_PLAINTEXT_EXTENSIONS.has(ext)) {
      // The exists() check above is a no-op on S3 (it answers true and lets the signed-URL request
      // do the checking), so this branch — the only one that reads the bytes here rather than
      // redirecting — is where a missing object actually surfaces. Without the catch it escapes as
      // a 500, reporting a server fault for a file that is merely gone.
      const buffer = await this.storage.getBuffer(file.storage_key).catch(() => null);
      if (!buffer) throw new NotFoundException({ error: "File content is not available" });
      return { buffer, mimeType, originalFileName: file.original_file_name };
    }
    const access = await this.storage.getAccessUrl(file.storage_key, { filename: file.original_file_name, inline, contentType: mimeType });
    return { ...access, mimeType, originalFileName: file.original_file_name };
  }

  // ─── Knowledge Base v2: search ─────────────────────────────────────────────

  async searchKnowledgeBase(projectId: string, userId: string | null | undefined, query: Body) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const q = String(query.q || "").trim();
    if (!q) return { list: [], total: 0 };
    const type = String(query.type || "all").toLowerCase();

    let dateClause = "";
    const dateFilter = String(query.date || "").toLowerCase();
    if (dateFilter === "today") dateClause = "AND updated_at >= date_trunc('day', now())";
    else if (dateFilter === "week") dateClause = "AND updated_at >= now() - interval '7 days'";
    else if (dateFilter === "month") dateClause = "AND updated_at >= now() - interval '30 days'";

    const results: Body[] = [];

    if (type === "all" || type === "folder") {
      const res = await this.db.query(
        `SELECT * FROM knowledge_folders WHERE project_id = $1 AND is_deleted = false AND name ILIKE $2 ${dateClause} LIMIT 50`,
        [projectId, `%${q}%`]
      );
      results.push(...res.rows.map((row) => Object.assign(toCamel(row), { type: "folder" })));
    }
    if (type === "all" || type === "document") {
      const res = await this.db.query(
        `SELECT * FROM knowledge_documents
         WHERE project_id = $1 AND is_deleted = false
         AND (search_vector @@ plainto_tsquery('english', $2) OR title ILIKE $3) ${dateClause}
         ORDER BY ts_rank(search_vector, plainto_tsquery('english', $2)) DESC LIMIT 50`,
        [projectId, q, `%${q}%`]
      );
      results.push(
        ...res.rows.map((row) => {
          const camelled = toCamel(row);
          delete camelled.searchVector;
          return Object.assign(camelled, { type: "document" });
        })
      );
    }
    if (type === "all" || type === "file") {
      const res = await this.db.query(
        `SELECT * FROM knowledge_files
         WHERE project_id = $1 AND is_deleted = false AND (original_file_name ILIKE $2 OR file_extension ILIKE $2) ${dateClause}
         LIMIT 50`,
        [projectId, `%${q}%`]
      );
      results.push(...res.rows.map((row) => Object.assign(this.kbFileView(row), { type: "file" })));
    }

    const withBreadcrumb = await Promise.all(
      results.map(async (item) => {
        const folderId = item.type === "folder" ? item.parentFolderId : item.folderId;
        const breadcrumb = folderId ? await this.kbBreadcrumb(folderId) : [];
        return { ...item, breadcrumb };
      })
    );

    return { list: withBreadcrumb, total: withBreadcrumb.length };
  }

  // ─── Knowledge Base v2: versioning ─────────────────────────────────────────

  async listKnowledgeDocumentVersions(projectId: string, userId: string | null | undefined, documentId: string) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    await this.kbDocument(projectId, documentId);
    const res = await this.db.query(
      "SELECT id, version_number, title, created_by, created_at FROM knowledge_document_versions WHERE document_id = $1 ORDER BY version_number DESC",
      [documentId]
    );
    return { list: res.rows.map(toCamel), total: res.rowCount };
  }

  async restoreKnowledgeDocumentVersion(projectId: string, userId: string | null | undefined, documentId: string, body: Body) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    const doc = await this.kbDocument(projectId, documentId);
    const role = await this.kbProjectRole(uid, projectId);
    this.kbRequireMutateAccess(role, doc.created_by, uid);

    // versionId is client input, so a missing or malformed one must read as "no such version"
    // rather than a failed uuid cast.
    const versionId = String(body.versionId || "");
    if (!isUuid(versionId)) throw new NotFoundException({ error: "Version not found" });
    const version = await this.db.query(
      "SELECT * FROM knowledge_document_versions WHERE id = $1 AND document_id = $2",
      [versionId, documentId]
    );
    if (!version.rows[0]) throw new NotFoundException({ error: "Version not found" });
    const v = version.rows[0];

    // Serialised per document, and sharing its lock key with the auto-snapshot step in
    // updateKnowledgeDocument — a concurrent restore and a concurrent edit both read-then-write
    // this same version_number sequence, and the table has no unique constraint to reject a
    // collision. The whole snapshot-then-overwrite sequence also runs inside one transaction so a
    // mid-sequence failure can never leave a snapshot inserted without the restore having applied,
    // or vice versa.
    const res = await this.db.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`kb-doc-version:${documentId}`]);

      // Re-read the document fresh, inside the lock — `doc` above may already be stale by the time
      // this transaction gets to run, e.g. a concurrent edit committed while we waited on the lock.
      const current = await client.query(
        `SELECT title, content_json, content_html, content_text FROM knowledge_documents
         WHERE id = $1 AND project_id = $2 AND is_deleted = false FOR UPDATE`,
        [documentId, projectId]
      );
      if (!current.rows[0]) throw new NotFoundException({ error: "Document not found" });
      const cur = current.rows[0];

      // Restoring a version whose content already matches the current document (restoring the
      // same version twice in a row, or a stray extra click before the UI caught up) has nothing to
      // snapshot — skip the insert so repeated restores don't pile up identical junk versions, but
      // still apply the write below so the call remains a normal, idempotent success.
      const isNoop =
        cur.title === v.title &&
        cur.content_html === v.content_html &&
        cur.content_text === v.content_text &&
        JSON.stringify(cur.content_json) === JSON.stringify(v.content_json);

      if (!isNoop) {
        // Snapshot the current state before overwriting, so restoring a version is itself reversible.
        const nextVersion = await client.query<{ max: number }>(
          "SELECT COALESCE(MAX(version_number), 0) + 1 AS max FROM knowledge_document_versions WHERE document_id = $1",
          [documentId]
        );
        await client.query(
          `INSERT INTO knowledge_document_versions (document_id, version_number, title, content_json, content_html, content_text, created_by)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
          [documentId, nextVersion.rows[0].max, cur.title, cur.content_json ? JSON.stringify(cur.content_json) : null, cur.content_html, cur.content_text, uid]
        );
      }

      return client.query(
        `UPDATE knowledge_documents SET title = $2, content_json = $3::jsonb, content_html = $4, content_text = $5, updated_by = $6, updated_at = now()
         WHERE id = $1 RETURNING ${LegacyService.KB_DOCUMENT_COLUMNS}`,
        [documentId, v.title, v.content_json ? JSON.stringify(v.content_json) : null, v.content_html, v.content_text, uid]
      );
    });
    await this.logProjectActivity(projectId, uid, "restored_version", "knowledge_document", documentId, res.rows[0].title, { versionNumber: v.version_number });
    return toCamel(res.rows[0]);
  }

  // ─── Knowledge Base v2: AI memory approval ─────────────────────────────────

  async approveAiMemory(projectId: string, userId: string | null | undefined, documentId: string) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    const role = await this.kbProjectRole(uid, projectId);
    this.kbRequireOwnerOrManager(role);
    const doc = await this.kbDocument(projectId, documentId);
    if (doc.document_type !== "ai_memory")
      throw new BadRequestException({ error: "Only AI memory documents can be approved" });

    const res = await this.db.query(
      `UPDATE knowledge_documents SET status = 'approved', reviewed_by = $2, reviewed_at = now(), updated_at = now()
       WHERE id = $1 RETURNING ${LegacyService.KB_DOCUMENT_COLUMNS}`,
      [documentId, uid]
    );
    await this.logProjectActivity(projectId, uid, "approved", "knowledge_document", documentId, res.rows[0].title, {});
    return toCamel(res.rows[0]);
  }

  async rejectAiMemory(projectId: string, userId: string | null | undefined, documentId: string) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    const role = await this.kbProjectRole(uid, projectId);
    this.kbRequireOwnerOrManager(role);
    const doc = await this.kbDocument(projectId, documentId);
    if (doc.document_type !== "ai_memory")
      throw new BadRequestException({ error: "Only AI memory documents can be rejected" });

    const res = await this.db.query(
      `UPDATE knowledge_documents SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), updated_at = now()
       WHERE id = $1 RETURNING ${LegacyService.KB_DOCUMENT_COLUMNS}`,
      [documentId, uid]
    );
    await this.logProjectActivity(projectId, uid, "rejected", "knowledge_document", documentId, res.rows[0].title, {});
    return toCamel(res.rows[0]);
  }

  async adminCustomers(userId: string | null | undefined) {
    await this.requirePlatformAdmin(userId);
    const summary = await this.analytics();
    const customers = await this.db.query(
      `SELECT o.id, o.name, o.slug, o.created_at,
              COUNT(DISTINCT om.user_id)::int AS member_count,
              COUNT(DISTINCT p.id)::int AS project_count,
              COUNT(DISTINCT t.id)::int AS test_case_count,
              COUNT(DISTINCT t.id) FILTER (WHERE t.automation_status <> 'Not Automated')::int AS automated_count,
              MAX(GREATEST(o.updated_at, p.updated_at, t.updated_at)) AS last_activity_at
       FROM organizations o
       LEFT JOIN organization_members om ON om.organization_id = o.id
       LEFT JOIN projects p ON p.organization_id = o.id
       LEFT JOIN testcases t ON t.project_id = p.id
       GROUP BY o.id ORDER BY o.created_at DESC`
    );
    return {
      summary: {
        totalOrganizations: summary.projectCount,
        totalMembers: 0,
        totalProjects: summary.projectCount,
        totalTestCases: summary.testCaseCount,
        totalAutomated: 0,
        overallAutomationCoverage: 0
      },
      customers: customers.rows.map((row) => {
        const item = toCamel(row);
        const total = Number(item.testCaseCount || 0);
        const automated = Number(item.automatedCount || 0);
        return { ...item, automationCoverage: total ? Math.round((automated / total) * 100) : 0 };
      })
    };
  }

  async adminList(userId: string | null | undefined) {
    await this.requirePlatformAdmin(userId);
    const res = await this.db.query(
      `SELECT pa.id, pa.user_id, pa.role, u.email, u.name, u.avatar_url, pa.granted_by,
              gb.email AS granted_by_email, gb.name AS granted_by_name, pa.created_at
       FROM platform_admins pa
       JOIN users u ON u.id = pa.user_id
       LEFT JOIN users gb ON gb.id = pa.granted_by
       ORDER BY pa.created_at`
    );
    return res.rows.map((row) => {
      const item = toCamel(row);
      if (row.granted_by) {
        item.grantedBy = { email: row.granted_by_email, name: row.granted_by_name };
      }
      delete item.grantedByEmail;
      delete item.grantedByName;
      return item;
    });
  }

  async publicBranding() {
    const res = await this.db.query("SELECT value FROM platform_settings WHERE key = 'branding'").catch(() => ({ rows: [] as Body[] }));
    const value = res.rows[0]?.value || {};
    return {
      productName: String(value.productName || "Tesbo Test Manager"),
      logoUrl: String(value.logoUrl || DEFAULT_BRAND_LOGO_URL)
    };
  }

  async adminBranding(userId: string | null | undefined) {
    await this.requirePlatformAdmin(userId);
    return this.publicBranding();
  }

  async updateAdminBranding(userId: string | null | undefined, body: Body) {
    const uid = await this.requirePlatformAdmin(userId);
    const logoUrl = String(body.logoUrl || "").trim();
    const productName = String(body.productName || "Tesbo Test Manager").trim() || "Tesbo Test Manager";
    if (logoUrl && !/^data:image\/(png|jpe?g|webp|svg\+xml);base64,/i.test(logoUrl) && !logoUrl.startsWith("/")) {
      throw new BadRequestException({ error: "Logo must be an uploaded image data URL or a public app asset path." });
    }
    if (logoUrl.length > 2_500_000) {
      throw new BadRequestException({ error: "Logo is too large. Upload an image below 2 MB." });
    }
    const value = {
      productName,
      logoUrl: logoUrl || DEFAULT_BRAND_LOGO_URL
    };
    await this.db.query(
      `INSERT INTO platform_settings (key, value, updated_by, updated_at)
       VALUES ('branding', $1::jsonb, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [JSON.stringify(value), uid]
    );
    return value;
  }

  async addAdmin(userId: string | null | undefined, body: Body) {
    const grantedBy = await this.requirePlatformAdmin(userId);
    const email = String(body.email || "").trim().toLowerCase();
    if (!email) throw new BadRequestException({ error: "email is required" });
    const uid = await this.upsertUser(email);
    const res = await this.db.query(
      "INSERT INTO platform_admins (user_id, role, granted_by) VALUES ($1, 'admin', $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role RETURNING id, user_id, role",
      [uid, grantedBy]
    );
    return { ...toCamel(res.rows[0]), email };
  }

  async deleteAdmin(userId: string | null | undefined, adminId: string) {
    await this.requirePlatformAdmin(userId);
    await this.db.query("DELETE FROM platform_admins WHERE id = $1 AND role <> 'owner'", [adminId]);
  }

  async genericEmptyList() {
    return [];
  }

  // ── App integrations (Jira, Linear) ──
  // The OAuth connection (and its client id/secret) is workspace-scoped — one per organization
  // per provider — so a customer connects Jira/Linear once instead of re-authenticating every
  // project. Which remote project/team feeds which Tesbo project is a separate per-project mapping
  // on top of that shared connection (jira_project_mappings / linear_project_mappings).

  // The platform OAuth app: Tesbo registers one app per provider and supplies its credentials
  // through the environment, so a workspace owner just clicks Connect. `*_REDIRECT_URI` is
  // optional — the callback path is fixed by the frontend route, so it is derived from FRONTEND_URL
  // unless an operator overrides it (e.g. a proxy that terminates on a different host).
  private envIntegrationConfig(provider: IntegrationProvider) {
    const prefix = provider.toUpperCase();
    const clientId = (process.env[`${prefix}_CLIENT_ID`] || "").trim();
    const clientSecret = (process.env[`${prefix}_CLIENT_SECRET`] || "").trim();
    if (!clientId || !clientSecret) return null;
    const redirectUri = (process.env[`${prefix}_REDIRECT_URI`] || "").trim() || this.defaultIntegrationRedirectUri();
    return { clientId, clientSecret, redirectUri };
  }

  private defaultIntegrationRedirectUri() {
    const frontend = process.env.FRONTEND_URL || process.env.APP_URL || "http://localhost:1010";
    return `${frontend.replace(/\/$/, "")}/integrations/callback`;
  }

  // Deployment-level configuration only. There is deliberately no per-workspace override: the
  // operator registers one OAuth app and sets *_CLIENT_ID/*_CLIENT_SECRET, and every workspace in
  // the deployment connects through it with a single click. Tesbo Cloud and a self-hosted install
  // differ only in whose app the credentials belong to.
  private integrationOAuthConfig(provider: IntegrationProvider) {
    const env = this.envIntegrationConfig(provider);
    if (env) return env;
    const prefix = provider.toUpperCase();
    throw new BadRequestException({
      error: `${provider} is not configured on this deployment. Set ${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET in the backend environment and restart.`
    });
  }

  private async projectOrganizationId(projectId: string): Promise<string> {
    const res = await this.db.query<{ organization_id: string }>("SELECT organization_id FROM projects WHERE id = $1", [projectId]);
    const organizationId = res.rows[0]?.organization_id;
    if (!organizationId) throw new NotFoundException({ error: "Project not found." });
    return organizationId;
  }

  // Tells the UI whether this deployment can connect the provider at all. Read-only: there is
  // nothing for a workspace to configure, so the shape is just "is it set up, and where does the
  // callback land" — the latter being what an operator needs to register in the provider console.
  async integrationConfigStatus(userId: string | null | undefined, provider: string) {
    const p = assertIntegrationProvider(provider);
    await this.workspace(userId);
    const env = this.envIntegrationConfig(p);
    return {
      configured: !!env,
      clientId: env?.clientId ?? "",
      redirectUri: env?.redirectUri ?? this.defaultIntegrationRedirectUri()
    };
  }

  async integrationAuthUrl(userId: string | null | undefined, provider: string) {
    const p = assertIntegrationProvider(provider);
    const workspace = await this.workspace(userId);
    if (this.normalizeRole(workspace.role) !== "owner") throw new ForbiddenException({ error: "Only the workspace owner can manage integrations" });
    const { clientId, redirectUri } = this.integrationOAuthConfig(p);
    const state = signOAuthState(p, workspace.id);
    if (p === "jira") {
      const params = new URLSearchParams({
        audience: "api.atlassian.com",
        client_id: clientId,
        scope: JIRA_OAUTH_SCOPE,
        redirect_uri: redirectUri,
        state,
        response_type: "code",
        prompt: "consent"
      });
      return { url: `https://auth.atlassian.com/authorize?${params.toString()}` };
    }
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: LINEAR_OAUTH_SCOPE,
      state,
      response_type: "code",
      prompt: "consent"
    });
    return { url: `https://linear.app/oauth/authorize?${params.toString()}` };
  }

  async integrationCallback(userId: string | null | undefined, provider: string, body: Body) {
    const p = assertIntegrationProvider(provider);
    const workspace = await this.workspace(userId);
    if (this.normalizeRole(workspace.role) !== "owner") throw new ForbiddenException({ error: "Only the workspace owner can manage integrations" });
    await this.planLimits.assertIntegrationAllowed(workspace.id, p);
    const code = String(body.code || "");
    if (!code) throw new BadRequestException({ error: "Authorization code is required." });
    verifyOAuthState(String(body.state || ""), p, workspace.id);
    const { clientId, clientSecret, redirectUri } = this.integrationOAuthConfig(p);

    if (p === "jira") {
      const token = await this.jiraFetch<Body>("https://auth.atlassian.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri
        })
      });
      const accessToken = String(token.access_token || "");
      const refreshToken = String(token.refresh_token || "");
      if (!accessToken || !refreshToken) throw new BadRequestException({ error: "Jira did not return OAuth tokens." });

      const resources = await this.jiraFetch<Body[]>("https://api.atlassian.com/oauth/token/accessible-resources", {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const resource = resources[0];
      if (!resource?.id || !resource?.url) throw new BadRequestException({ error: "No accessible Jira site was found." });

      const expiresAt = new Date(Date.now() + Number(token.expires_in || 3600) * 1000).toISOString();
      const res = await this.db.query(
        `INSERT INTO integration_connections (organization_id, provider, external_id, site_url, access_token, refresh_token, token_expires_at, connected_by, auth_method, personal_token_identifier)
         VALUES ($1, 'jira', $2, $3, $4, $5, $6, $7, 'oauth', NULL)
         ON CONFLICT (organization_id, provider) DO UPDATE SET
           external_id = EXCLUDED.external_id,
           site_url = EXCLUDED.site_url,
           access_token = EXCLUDED.access_token,
           refresh_token = EXCLUDED.refresh_token,
           token_expires_at = EXCLUDED.token_expires_at,
           connected_by = EXCLUDED.connected_by,
           auth_method = 'oauth',
           personal_token_identifier = NULL,
           disconnected_at = NULL,
           updated_at = now()
         RETURNING id, external_id, site_url`,
        [workspace.id, String(resource.id), String(resource.url), encryptSecret(accessToken), encryptSecret(refreshToken), expiresAt, userId || null]
      );
      return { connectionId: res.rows[0].id, cloudId: res.rows[0].external_id, siteUrl: res.rows[0].site_url };
    }

    // Linear
    const token = await this.jiraFetch<Body>("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri
      }).toString()
    });
    const accessToken = String(token.access_token || "");
    if (!accessToken) throw new BadRequestException({ error: "Linear did not return an OAuth token." });
    const viewer = await this.linearGraphQL<Body>(`Bearer ${accessToken}`, "query { organization { id urlKey } }");
    const org = viewer?.organization;
    if (!org?.urlKey) throw new BadRequestException({ error: "Could not read the connected Linear workspace." });
    const expiresAt = new Date(Date.now() + Number(token.expires_in || 315360000) * 1000).toISOString();
    const res = await this.db.query(
      `INSERT INTO integration_connections (organization_id, provider, external_id, site_url, access_token, refresh_token, token_expires_at, connected_by, auth_method, personal_token_identifier)
       VALUES ($1, 'linear', $2, $3, $4, $5, $6, $7, 'oauth', NULL)
       ON CONFLICT (organization_id, provider) DO UPDATE SET
         external_id = EXCLUDED.external_id,
         site_url = EXCLUDED.site_url,
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         token_expires_at = EXCLUDED.token_expires_at,
         connected_by = EXCLUDED.connected_by,
         auth_method = 'oauth',
         personal_token_identifier = NULL,
         disconnected_at = NULL,
         updated_at = now()
       RETURNING id, site_url`,
      [workspace.id, String(org.id || ""), `https://linear.app/${org.urlKey}`, encryptSecret(accessToken), encryptSecret(String(token.refresh_token || "")), expiresAt, userId || null]
    );
    return { connectionId: res.rows[0].id, siteUrl: res.rows[0].site_url };
  }

  async integrationDisconnect(userId: string | null | undefined, provider: string) {
    const p = assertIntegrationProvider(provider);
    const workspace = await this.workspace(userId);
    if (this.normalizeRole(workspace.role) !== "owner") throw new ForbiddenException({ error: "Only the workspace owner can manage integrations" });
    // Settle any in-flight sync before touching the connection, so the sync processor isn't
    // concurrently writing to a run this same disconnect is about to invalidate.
    await this.integrationSync.failActiveRunsForConnection(workspace.id, p, "Disconnected before this sync finished.");
    const mappingsTable = p === "jira" ? "jira_project_mappings" : "linear_project_mappings";
    const connectionColumn = p === "jira" ? "jira_connection_id" : "integration_connection_id";
    // A soft disconnect, not a DELETE: jira_tickets/linear_tickets and both mapping tables have
    // ON DELETE CASCADE back to this row (V47), so physically deleting it would silently destroy
    // every ticket ever synced through this connection. Instead: mark it disconnected and clear the
    // live credentials (so it can't be used even if some path forgets to check disconnected_at),
    // and disable every mapping it fed — CASCADE no longer does that for us since nothing is
    // deleted. Every ticket/mapping row stays exactly as it was, current or historical.
    await this.db.transaction(async (client) => {
      await client.query(
        "UPDATE integration_connections SET disconnected_at = now(), access_token = '', refresh_token = '', updated_at = now() WHERE organization_id = $1 AND provider = $2",
        [workspace.id, p]
      );
      await client.query(
        `UPDATE ${mappingsTable} SET enabled = false
         WHERE enabled = true AND ${connectionColumn} = (
           SELECT id FROM integration_connections WHERE organization_id = $1 AND provider = $2
         )`,
        [workspace.id, p]
      );
    });
    return { disconnected: true };
  }

  async integrationStatus(userId: string | null | undefined, provider: string) {
    const p = assertIntegrationProvider(provider);
    const workspace = await this.workspace(userId);
    const connection = await this.getIntegrationConnection(workspace.id, p, false);
    if (!connection) return { connected: false, connectedProjects: [] };
    const mappingsTable = p === "jira" ? "jira_project_mappings" : "linear_project_mappings";
    const connectionColumn = p === "jira" ? "jira_connection_id" : "integration_connection_id";
    const projects = await this.db.query(
      `SELECT m.project_id, p.name AS project_name, p.key AS project_key
       FROM ${mappingsTable} m
       JOIN projects p ON p.id = m.project_id
       WHERE m.${connectionColumn} = $1 AND m.enabled = true
       GROUP BY m.project_id, p.name, p.key
       ORDER BY p.name`,
      [connection.id]
    );
    return {
      connected: true,
      id: connection.id,
      siteUrl: connection.site_url,
      tokenExpiresAt: connection.token_expires_at,
      connectedBy: connection.connected_by,
      createdAt: connection.created_at,
      connectedProjects: projects.rows.map(toCamel)
    };
  }

  /*
   * Every project-scoped integration method below takes the caller and resolves the project first.
   *
   * None of them did. Their controller methods had no @Req(), so the whole Jira/Linear surface
   * answered anyone who knew a project id, with no session and from any workspace: the mirrored
   * ticket store (issue keys, summaries, assignees and URLs from the customer's tracker) was
   * readable, the project-to-remote-project mapping was rewritable, and jiraComment/linearComment
   * posted to the customer's real Jira or Linear using the workspace's stored OAuth token.
   */
  async jiraStatus(projectId: string, userId: string | null | undefined) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    return this.jiraStatusForProject(projectId);
  }

  /**
   * jiraStatus without the caller check, for internal callers that have already authorized.
   *
   * The Zyra helpers below reach this from a chat turn whose project access was resolved when the
   * session was opened, and they hold no userId to re-check with. Keeping the unguarded body
   * private — rather than leaving the public method unguarded, which is what it used to be — means
   * every route still goes through the check.
   */
  private async jiraStatusForProject(projectId: string) {
    const connection = await this.getJiraConnection(projectId, false);
    if (!connection) return { connected: false, connectedProjects: [], history: [] };
    const projects = await this.db.query(
      `SELECT id, jira_project_id, jira_project_key, jira_project_name, created_at
       FROM jira_project_mappings
       WHERE project_id = $1 AND enabled = true
       ORDER BY jira_project_key`,
      [projectId]
    );
    // Every Jira project this Tesbo project has ever been linked to (never deleted, only disabled)
    // — lets the UI offer a "previously linked" source picker instead of that history being
    // reachable only by direct DB inspection.
    const history = await this.db.query(
      `SELECT id, jira_project_id, jira_project_key, jira_project_name, created_at
       FROM jira_project_mappings
       WHERE project_id = $1 AND enabled = false
       ORDER BY created_at DESC`,
      [projectId]
    );
    return {
      connected: true,
      id: connection.id,
      cloudId: connection.cloud_id,
      siteUrl: connection.site_url,
      tokenExpiresAt: connection.token_expires_at,
      connectedBy: connection.connected_by,
      createdAt: connection.created_at,
      connectedProjects: projects.rows.map(toCamel),
      history: history.rows.map(toCamel)
    };
  }

  async jiraProjects(projectId: string, userId: string | null | undefined) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const connection = await this.getJiraConnection(projectId, true);
    if (!connection) throw new NotFoundException({ error: "Jira is not connected." });
    const { baseUrl, headers } = this.jiraBaseUrlAndAuth(connection);
    const data = await this.jiraFetch<Body>(`${baseUrl}/rest/api/3/project/search?maxResults=100`, { headers });
    const connected = await this.db.query(
      "SELECT jira_project_id FROM jira_project_mappings WHERE project_id = $1 AND enabled = true",
      [projectId]
    );
    const connectedIds = new Set(connected.rows.map((row) => String(row.jira_project_id)));
    return normalizeJsonArray(data.values).map((project) => ({
      id: String(project.id || ""),
      key: String(project.key || ""),
      name: String(project.name || project.key || "Jira project"),
      style: String(project.style || ""),
      connected: connectedIds.has(String(project.id || ""))
    })).filter((project) => project.id && project.key);
  }

  async connectJiraProjects(projectId: string, userId: string | null | undefined, body: Body) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const connection = await this.getJiraConnection(projectId, false);
    if (!connection) throw new NotFoundException({ error: "Jira is not connected." });
    const projects = normalizeJsonArray(body.projects)
      .map((project) => ({
        id: String(project.id || "").trim(),
        key: String(project.key || "").trim(),
        name: String(project.name || project.key || "").trim()
      }))
      .filter((project) => project.id && project.key);
    // Exactly one Jira project per Tesbo project (enforced in the schema by
    // idx_jira_project_mappings_one_per_project). Linking a different one replaces the link;
    // the previous mapping's already-synced tickets and Knowledge Base documents are left alone.
    if (projects.length > 1) throw new BadRequestException({ error: "Link one Jira project at a time to this project." });

    // Disable rather than DELETE: the outgoing mapping's jira_tickets rows and mirrored Knowledge
    // Base documents reference it, and re-linking the same project later restores continuity
    // instead of re-mirroring from scratch. An empty request is an explicit unlink.
    const [project] = projects;
    try {
      await this.db.transaction(async (client) => {
        await client.query("UPDATE jira_project_mappings SET enabled = false WHERE project_id = $1 AND enabled = true", [projectId]);
        if (!project) return;
        await client.query(
          `INSERT INTO jira_project_mappings (jira_connection_id, project_id, jira_project_id, jira_project_key, jira_project_name)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (jira_connection_id, jira_project_id, project_id) DO UPDATE SET
             jira_project_key = EXCLUDED.jira_project_key,
             jira_project_name = EXCLUDED.jira_project_name,
             enabled = true`,
          [connection.id, projectId, project.id, project.key, project.name]
        );
      });
    } catch (error) {
      // idx_jira_project_mappings_one_per_project (partial unique on project_id WHERE enabled=true)
      // rejects a second concurrent save-mapping request for this project — a double-click or two
      // tabs racing this same endpoint. Translate the raw DB conflict into the same message the UI
      // already renders for any 409 (lib/api.ts's genericStatusMessage) instead of a raw 500.
      if ((error as { code?: string })?.code === "23505") {
        throw new ConflictException({ error: "This project's Jira link was just changed by another action. Reload and try again." });
      }
      throw error;
    }
    return { linked: project ? 1 : 0 };
  }

  async syncJira(userId: string | null | undefined, projectId: string) {
    return this.startIntegrationSync(userId, projectId, "jira");
  }

  // ── Integration -> Knowledge Base sync (queued) ──
  // Sync used to page the provider API inline on the request thread and mirror documents as it
  // went, which meant a large backlog either timed out the HTTP call or blocked it for minutes
  // with no feedback. Both providers now hand off to IntegrationSyncModule's queue and return
  // immediately with a run the UI can poll; the pipeline itself lives in
  // integration-sync.processor.ts.

  private async startIntegrationSync(userId: string | null | undefined, projectId: string, provider: IntegrationProvider) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    const organizationId = await this.projectOrganizationId(projectId);
    const label = provider === "jira" ? "Jira" : "Linear";

    const connection = await this.getIntegrationConnection(organizationId, provider, false);
    if (!connection) throw new NotFoundException({ error: `${label} is not connected.` });

    const mapping = await this.db.query<{ remote_key: string }>(
      provider === "jira"
        ? "SELECT jira_project_key AS remote_key FROM jira_project_mappings WHERE project_id = $1 AND enabled = true LIMIT 1"
        : "SELECT linear_team_key AS remote_key FROM linear_project_mappings WHERE project_id = $1 AND enabled = true LIMIT 1",
      [projectId]
    );
    const remoteKey = mapping.rows[0]?.remote_key ? String(mapping.rows[0].remote_key) : null;
    if (!remoteKey) {
      throw new BadRequestException({ error: `Link a ${label} ${provider === "jira" ? "project" : "team"} to this project before syncing.` });
    }

    const { run, alreadyRunning } = await this.integrationSync.startRun(organizationId, projectId, provider, uid, remoteKey);
    // Only the click that actually started a run is an activity event — a second click that
    // joined the in-flight run isn't a separate sync.
    if (!alreadyRunning) {
      await this.logProjectActivity(projectId, uid, "integration.sync.started", "integration", run.id, `${label} · ${remoteKey}`, {
        provider,
        remoteKey,
        runId: run.id
      });
    }
    return { run, alreadyRunning };
  }

  async integrationSyncStatus(userId: string | null | undefined, projectId: string, provider: string) {
    await this.requireProjectAccess(userId, projectId);
    return { run: await this.integrationSync.getLatestRun(projectId, assertIntegrationProvider(provider)) };
  }

  async integrationSyncHistory(userId: string | null | undefined, projectId: string) {
    await this.requireProjectAccess(userId, projectId);
    return { runs: await this.integrationSync.listRecentRuns(projectId) };
  }

  async jiraTickets(projectId: string, userId: string | null | undefined, query: Body) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const limit = pageNumber(query.limit, 25, 0, 100);
    const offset = pageNumber(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const search = String(query.search || "").trim();
    const filters = ["project_id = $1"];
    const values: any[] = [projectId];
    // No remoteId: scope to whatever's *currently* mapped, so a project that has ever been
    // switched to a different Jira project doesn't mix the two together (this was the bug).
    // An explicit remoteId (from the mapping "history" list) opts into browsing one specific past
    // mapping's tickets instead.
    const remoteId = String(query.remoteId || "").trim();
    if (remoteId) {
      values.push(remoteId);
      filters.push(`mapped_remote_id = $${values.length}`);
    } else {
      filters.push(
        `mapped_remote_id = (SELECT jira_project_id FROM jira_project_mappings WHERE project_id = $1 AND enabled = true LIMIT 1)`
      );
    }
    if (search) {
      values.push(`%${search}%`);
      filters.push(`(jira_issue_key ILIKE $${values.length} OR summary ILIKE $${values.length})`);
    }
    if (query.issueType) {
      values.push(String(query.issueType));
      filters.push(`issue_type = $${values.length}`);
    }
    if (query.status) {
      values.push(String(query.status));
      filters.push(`status = $${values.length}`);
    }
    if (query.coverage === "covered" || query.coverage === "uncovered") {
      const exists = `EXISTS (SELECT 1 FROM testcases t WHERE t.project_id = jira_tickets.project_id AND t.jira_issue_key = jira_tickets.jira_issue_key AND t.deleted_at IS NULL)`;
      filters.push(query.coverage === "covered" ? exists : `NOT ${exists}`);
    }
    const count = await this.db.query(`SELECT COUNT(*)::int AS count FROM jira_tickets WHERE ${filters.join(" AND ")}`, values);
    values.push(limit, offset);
    const res = await this.db.query(
      `SELECT * FROM jira_tickets
       WHERE ${filters.join(" AND ")}
       ORDER BY jira_updated_at DESC NULLS LAST, synced_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { list: res.rows.map(toCamel), total: count.rows[0]?.count ?? 0 };
  }

  async jiraComment(projectId: string, userId: string | null | undefined, body: Body) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const connection = await this.getJiraConnection(projectId, true);
    if (!connection) throw new NotFoundException({ error: "Jira is not connected." });
    const issueKey = String(body.issueKey || body.jiraIssueKey || "").trim();
    const comment = String(body.comment || body.body || "").trim();
    if (!issueKey || !comment) throw new BadRequestException({ error: "Jira issue key and comment are required." });
    const { baseUrl, headers } = this.jiraBaseUrlAndAuth(connection);
    await this.jiraFetch(
      `${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          body: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: comment }] }]
          }
        })
      }
    );
    return { ok: true };
  }

  // Live search against Jira (not the jira_tickets sync cache) — used by the bug-linking picker,
  // where a ticket filed moments ago may not have synced yet.
  async jiraSearchIssues(projectId: string, userId: string | null | undefined, query: Body) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const connection = await this.getJiraConnection(projectId, true);
    if (!connection) throw new NotFoundException({ error: "Jira is not connected." });
    const mappings = await this.db.query(
      "SELECT jira_project_key FROM jira_project_mappings WHERE project_id = $1 AND enabled = true",
      [projectId]
    );
    const keys = mappings.rows.map((row) => String(row.jira_project_key)).filter(Boolean);
    if (!keys.length) return { list: [] };

    const projectClause = `project in (${keys.map((key) => `"${escapeJql(key)}"`).join(", ")})`;
    const search = String(query.search || query.q || "").trim();
    const jql = search
      ? `${projectClause} AND (summary ~ "${escapeJql(search)}*" OR key = "${escapeJql(search.toUpperCase())}") ORDER BY updated DESC`
      : `${projectClause} ORDER BY updated DESC`;
    const { baseUrl, headers } = this.jiraBaseUrlAndAuth(connection);
    const data = await this.jiraFetch<Body>(
      `${baseUrl}/rest/api/3/search/jql`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ jql, maxResults: 20, fields: ["summary", "status"] })
      }
    );
    return {
      list: normalizeJsonArray(data.issues).map((issue) => ({
        provider: "JIRA",
        key: String(issue.key || ""),
        summary: String((issue.fields as Body)?.summary || ""),
        status: String((issue.fields as Body)?.status?.name || ""),
        url: `${connection.site_url}/browse/${issue.key}`
      }))
    };
  }

  private async getJiraConnection(projectId: string, refresh: boolean): Promise<Body | null> {
    const organizationId = await this.projectOrganizationId(projectId);
    const connection = await this.getIntegrationConnection(organizationId, "jira", refresh);
    if (!connection) return null;
    return { ...connection, cloud_id: connection.external_id };
  }

  private async getIntegrationConnection(organizationId: string, provider: IntegrationProvider, refresh: boolean): Promise<Body | null> {
    // disconnected_at IS NULL: a soft-disconnected row (integrationDisconnect) still exists so its
    // historical tickets/mappings stay intact, but must read as "not connected" everywhere.
    const res = await this.db.query(
      "SELECT * FROM integration_connections WHERE organization_id = $1 AND provider = $2 AND disconnected_at IS NULL",
      [organizationId, provider]
    );
    const connection = res.rows[0] as Body | undefined;
    if (!connection) return null;
    if (!refresh || new Date(connection.token_expires_at).getTime() > Date.now() + 60_000) return connection;
    if (provider === "linear" || !connection.refresh_token) return connection; // Linear OAuth tokens are long-lived; no refresh flow needed today.

    const { clientId, clientSecret } = this.integrationOAuthConfig(provider);
    const token = await this.jiraFetch<Body>("https://auth.atlassian.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: decryptSecret(String(connection.refresh_token || ""))
      })
    });
    const accessToken = String(token.access_token || "");
    const refreshToken = String(token.refresh_token || decryptSecret(String(connection.refresh_token || "")));
    const expiresAt = new Date(Date.now() + Number(token.expires_in || 3600) * 1000).toISOString();
    const encryptedAccessToken = encryptSecret(accessToken);
    const encryptedRefreshToken = encryptSecret(refreshToken);
    await this.db.query(
      "UPDATE integration_connections SET access_token = $2, refresh_token = $3, token_expires_at = $4, updated_at = now() WHERE id = $1",
      [connection.id, encryptedAccessToken, encryptedRefreshToken, expiresAt]
    );
    return { ...connection, access_token: encryptedAccessToken, refresh_token: encryptedRefreshToken, token_expires_at: expiresAt };
  }

  // Every connection is OAuth, so Jira is always reached through the api.atlassian.com/ex/jira
  // gateway addressed by cloud_id, never the customer's own site URL.
  private jiraBaseUrlAndAuth(connection: Body): { baseUrl: string; headers: Record<string, string> } {
    return {
      baseUrl: `https://api.atlassian.com/ex/jira/${connection.cloud_id}`,
      headers: { Authorization: `Bearer ${decryptSecret(String(connection.access_token || ""))}` }
    };
  }

  private linearAuthHeader(connection: Body): string {
    return `Bearer ${decryptSecret(String(connection.access_token || ""))}`;
  }

  // A 401/403 here means the stored token was revoked/expired mid-session — the raw Atlassian/
  // Linear error body is not useful to a user and shouldn't be shown to one; every other status is
  // left with its existing (truncated) detail since those are less common and the detail still
  // helps in support/debugging.
  private cleanAuthErrorOrNull(provider: "Jira" | "Linear", status: number): BadRequestException | null {
    if (status !== 401 && status !== 403) return null;
    return new BadRequestException({ error: `${provider} access needs to be reconnected — the authorization may have been revoked or expired.` });
  }

  /** True for exactly the error cleanAuthErrorOrNull produces — used to tell "this connection's
   *  token is dead" apart from any other failure when settling more than one call in parallel. */
  private isReconnectError(err: unknown): boolean {
    return err instanceof BadRequestException && /needs to be reconnected/i.test(String((err.getResponse() as Body)?.error || ""));
  }

  private async jiraFetch<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(url, init);
    if (!res.ok) {
      const authError = this.cleanAuthErrorOrNull("Jira", res.status);
      if (authError) throw authError;
      const text = await res.text().catch(() => "");
      throw new BadRequestException({ error: `Jira request failed (${res.status}).`, detail: text.slice(0, 500) });
    }
    return (await res.json()) as T;
  }

  private async linearGraphQL<T = unknown>(authHeader: string, query: string, variables?: Body): Promise<T> {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables })
    });
    if (!res.ok) {
      const authError = this.cleanAuthErrorOrNull("Linear", res.status);
      if (authError) throw authError;
      const text = await res.text().catch(() => "");
      throw new BadRequestException({ error: `Linear request failed (${res.status}).`, detail: text.slice(0, 500) });
    }
    const data = (await res.json()) as Body;
    if (data.errors) throw new BadRequestException({ error: "Linear request failed.", detail: JSON.stringify(data.errors).slice(0, 500) });
    return data.data as T;
  }

  // ── Linear-specific mirrors of the Jira project-scoped methods above ──
  // Linear's API is GraphQL (not REST like Jira's) and its unit of work is a "team" rather than a
  // "project" — kept as separate methods/tables rather than forcing a shared shape onto both APIs.

  async linearStatus(projectId: string, userId: string | null | undefined) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const organizationId = await this.projectOrganizationId(projectId);
    const connection = await this.getIntegrationConnection(organizationId, "linear", false);
    if (!connection) return { connected: false, connectedProjects: [], history: [] };
    const teams = await this.db.query(
      `SELECT id, linear_team_id, linear_team_key, linear_team_name, entity_type, created_at
       FROM linear_project_mappings
       WHERE project_id = $1 AND enabled = true
       ORDER BY linear_team_key`,
      [projectId]
    );
    // Every Linear team/project this Tesbo project has ever been linked to (never deleted, only
    // disabled) — lets the UI offer a "previously linked" source picker instead of that history
    // being reachable only by direct DB inspection.
    const history = await this.db.query(
      `SELECT id, linear_team_id, linear_team_key, linear_team_name, entity_type, created_at
       FROM linear_project_mappings
       WHERE project_id = $1 AND enabled = false
       ORDER BY created_at DESC`,
      [projectId]
    );
    return {
      connected: true,
      id: connection.id,
      siteUrl: connection.site_url,
      tokenExpiresAt: connection.token_expires_at,
      connectedBy: connection.connected_by,
      createdAt: connection.created_at,
      connectedProjects: teams.rows.map(toCamel),
      history: history.rows.map(toCamel)
    };
  }

  /**
   * Teams AND Projects, merged into one pickable list — Linear's own docs distinguish them (every
   * issue belongs to exactly one Team, mandatory; a Project is optional and can span multiple
   * Teams), and a user's "my project" can genuinely mean either depending on how their workspace is
   * organized, so both are offered rather than forcing one.
   *
   * The two GraphQL calls run via allSettled, not all/Promise.all: a transient failure fetching
   * Projects (rate limit, a future scope restriction) must not blank out Teams too — the picker
   * degrades to whichever half actually came back rather than failing the whole request over one
   * of two independent reads.
   */
  async linearTeams(projectId: string, userId: string | null | undefined) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const organizationId = await this.projectOrganizationId(projectId);
    const connection = await this.getIntegrationConnection(organizationId, "linear", true);
    if (!connection) throw new NotFoundException({ error: "Linear is not connected." });
    const authHeader = this.linearAuthHeader(connection);

    const [teamsResult, projectsResult] = await Promise.allSettled([
      this.linearGraphQL<Body>(authHeader, "query { teams { nodes { id key name } } }"),
      this.linearGraphQL<Body>(authHeader, "query { projects { nodes { id name slugId } } }")
    ]);

    // An expired/revoked token affects the whole connection, not just one of these two queries —
    // surface it immediately rather than quietly degrading to a partial list that would leave the
    // user wondering where their teams/projects went instead of telling them to reconnect.
    for (const result of [teamsResult, projectsResult]) {
      if (result.status === "rejected" && this.isReconnectError(result.reason)) throw result.reason;
    }

    const connected = await this.db.query<{ linear_team_id: string }>(
      "SELECT linear_team_id FROM linear_project_mappings WHERE project_id = $1 AND enabled = true",
      [projectId]
    );
    const connectedIds = new Set(connected.rows.map((row) => String(row.linear_team_id)));

    const entities: Array<{ id: string; key: string; name: string; style: string; connected: boolean; entityType: "team" | "project" }> = [];

    if (teamsResult.status === "fulfilled") {
      for (const team of normalizeJsonArray(teamsResult.value?.teams?.nodes)) {
        const id = String(team.id || "");
        const key = String(team.key || "");
        if (!id || !key) continue;
        entities.push({ id, key, name: String(team.name || key || "Linear team"), style: "", connected: connectedIds.has(id), entityType: "team" });
      }
    } else {
      this.logger.warn(`Linear teams list failed for project ${projectId}: ${teamsResult.reason instanceof Error ? teamsResult.reason.message : teamsResult.reason}`);
    }

    if (projectsResult.status === "fulfilled") {
      for (const project of normalizeJsonArray(projectsResult.value?.projects?.nodes)) {
        const id = String(project.id || "");
        // slugId, not the internal/nullable `identifier` field — Linear Projects have no short key
        // the way Teams do, but slugId is real, non-null, and stable, which is all a "key" needs to
        // be here (it's purely a display token downstream, never a uniqueness/format constraint).
        const key = String(project.slugId || "");
        if (!id || !key) continue;
        entities.push({ id, key, name: String(project.name || key || "Linear project"), style: "", connected: connectedIds.has(id), entityType: "project" });
      }
    } else {
      this.logger.warn(`Linear projects list failed for project ${projectId}: ${projectsResult.reason instanceof Error ? projectsResult.reason.message : projectsResult.reason}`);
    }

    return entities;
  }

  async connectLinearTeams(projectId: string, userId: string | null | undefined, body: Body) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const organizationId = await this.projectOrganizationId(projectId);
    const connection = await this.getIntegrationConnection(organizationId, "linear", false);
    if (!connection) throw new NotFoundException({ error: "Linear is not connected." });
    const rawItems = normalizeJsonArray(body.projects);
    // Reject a tampered/unknown entityType outright rather than silently coercing it — an omitted
    // value defaults to "team", which is what every pre-existing frontend build already sends and
    // keeps a rolling deploy (new backend, old frontend) working unchanged.
    for (const item of rawItems) {
      if (item.entityType !== undefined && item.entityType !== "team" && item.entityType !== "project") {
        throw new BadRequestException({ error: `Unknown Linear entity type: ${item.entityType}` });
      }
    }
    const teams = rawItems
      .map((team) => ({
        id: String(team.id || "").trim(),
        key: String(team.key || "").trim(),
        name: String(team.name || team.key || "").trim(),
        entityType: team.entityType === "project" ? "project" : "team"
      }))
      .filter((team) => team.id && team.key);
    // One Linear team/project per Tesbo project — same invariant as Jira above.
    if (teams.length > 1) throw new BadRequestException({ error: "Link one Linear team or project at a time to this project." });

    const [team] = teams;
    try {
      await this.db.transaction(async (client) => {
        await client.query("UPDATE linear_project_mappings SET enabled = false WHERE project_id = $1 AND enabled = true", [projectId]);
        if (!team) return;
        await client.query(
          `INSERT INTO linear_project_mappings (integration_connection_id, project_id, linear_team_id, linear_team_key, linear_team_name, entity_type)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (integration_connection_id, linear_team_id, project_id) DO UPDATE SET
             linear_team_key = EXCLUDED.linear_team_key,
             linear_team_name = EXCLUDED.linear_team_name,
             entity_type = EXCLUDED.entity_type,
             enabled = true`,
          [connection.id, projectId, team.id, team.key, team.name, team.entityType]
        );
      });
    } catch (error) {
      // idx_linear_project_mappings_one_per_project (partial unique on project_id WHERE enabled=true)
      // rejects a second concurrent save-mapping request for this project — a double-click or two
      // tabs racing this same endpoint. Translate the raw DB conflict into the same message the UI
      // already renders for any 409 (lib/api.ts's genericStatusMessage) instead of a raw 500.
      if ((error as { code?: string })?.code === "23505") {
        throw new ConflictException({ error: "This project's Linear link was just changed by another action. Reload and try again." });
      }
      throw error;
    }
    return { linked: team ? 1 : 0 };
  }

  async syncLinear(userId: string | null | undefined, projectId: string) {
    return this.startIntegrationSync(userId, projectId, "linear");
  }

  async linearTickets(projectId: string, userId: string | null | undefined, query: Body) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const limit = pageNumber(query.limit, 25, 0, 100);
    const offset = pageNumber(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const search = String(query.search || "").trim();
    const filters = ["project_id = $1"];
    const values: any[] = [projectId];
    // See jiraTickets' identical comment: default scope is the currently mapped team/project only;
    // remoteId opts into a specific past mapping from the "history" list instead.
    const remoteId = String(query.remoteId || "").trim();
    if (remoteId) {
      values.push(remoteId);
      filters.push(`mapped_remote_id = $${values.length}`);
    } else {
      filters.push(
        `mapped_remote_id = (SELECT linear_team_id FROM linear_project_mappings WHERE project_id = $1 AND enabled = true LIMIT 1)`
      );
    }
    if (search) {
      values.push(`%${search}%`);
      filters.push(`(linear_issue_key ILIKE $${values.length} OR summary ILIKE $${values.length})`);
    }
    if (query.issueType) {
      values.push(String(query.issueType));
      filters.push(`issue_type = $${values.length}`);
    }
    if (query.status) {
      values.push(String(query.status));
      filters.push(`status = $${values.length}`);
    }
    if (query.coverage === "covered" || query.coverage === "uncovered") {
      const exists = `EXISTS (SELECT 1 FROM testcases t WHERE t.project_id = linear_tickets.project_id AND t.linear_issue_key = linear_tickets.linear_issue_key AND t.deleted_at IS NULL)`;
      filters.push(query.coverage === "covered" ? exists : `NOT ${exists}`);
    }
    const count = await this.db.query(`SELECT COUNT(*)::int AS count FROM linear_tickets WHERE ${filters.join(" AND ")}`, values);
    values.push(limit, offset);
    const res = await this.db.query(
      `SELECT * FROM linear_tickets
       WHERE ${filters.join(" AND ")}
       ORDER BY linear_updated_at DESC NULLS LAST, synced_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { list: res.rows.map(toCamel), total: count.rows[0]?.count ?? 0 };
  }

  // Merged view for the Requirements page's "All Sources" tab — UNION ALL over jira_tickets and
  // linear_tickets into one shape (source discriminator + shared coverage flag), sharing one
  // pagination/search/filter pass instead of stitching two independently-paginated lists client-side.
  async allTickets(projectId: string, userId: string | null | undefined, query: Body) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const limit = pageNumber(query.limit, 25, 0, 100);
    const offset = pageNumber(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const search = String(query.search || "").trim();
    const combined = `
      SELECT id, 'jira' AS source, jira_issue_key AS key, summary, description, issue_type, status, priority,
             assignee, reporter, labels, jira_created_at AS created_at, jira_updated_at AS updated_at,
             jira_url AS url, synced_at,
             EXISTS (SELECT 1 FROM testcases t WHERE t.project_id = jira_tickets.project_id AND t.jira_issue_key = jira_tickets.jira_issue_key AND t.deleted_at IS NULL) AS has_coverage
      FROM jira_tickets
      WHERE project_id = $1
        AND mapped_remote_id = (SELECT jira_project_id FROM jira_project_mappings WHERE project_id = $1 AND enabled = true LIMIT 1)
      UNION ALL
      SELECT id, 'linear' AS source, linear_issue_key AS key, summary, description, issue_type, status, priority,
             assignee, reporter, labels, linear_created_at AS created_at, linear_updated_at AS updated_at,
             linear_url AS url, synced_at,
             EXISTS (SELECT 1 FROM testcases t WHERE t.project_id = linear_tickets.project_id AND t.linear_issue_key = linear_tickets.linear_issue_key AND t.deleted_at IS NULL) AS has_coverage
      FROM linear_tickets
      WHERE project_id = $1
        AND mapped_remote_id = (SELECT linear_team_id FROM linear_project_mappings WHERE project_id = $1 AND enabled = true LIMIT 1)
    `;
    const filters: string[] = [];
    const values: any[] = [projectId];
    if (search) {
      values.push(`%${search}%`);
      filters.push(`(key ILIKE $${values.length} OR summary ILIKE $${values.length})`);
    }
    if (query.issueType) {
      values.push(String(query.issueType));
      filters.push(`issue_type = $${values.length}`);
    }
    if (query.status) {
      values.push(String(query.status));
      filters.push(`status = $${values.length}`);
    }
    if (query.coverage === "covered" || query.coverage === "uncovered") {
      filters.push(`has_coverage = ${query.coverage === "covered"}`);
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const count = await this.db.query(`SELECT COUNT(*)::int AS count FROM (${combined}) combined ${where}`, values);
    values.push(limit, offset);
    const res = await this.db.query(
      `SELECT * FROM (${combined}) combined
       ${where}
       ORDER BY updated_at DESC NULLS LAST, synced_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { list: res.rows.map(toCamel), total: count.rows[0]?.count ?? 0 };
  }

  // Coverage/type/status aggregates for the Requirements page's stat strip + filter dropdown
  // options. Type/status are free-text synced verbatim from Jira/Linear (no fixed enum), so option
  // lists are derived from what's actually in the project rather than a hardcoded set.
  async requirementsSummary(projectId: string, userId: string | null | undefined) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const bySource = async (
      table: "jira_tickets" | "linear_tickets",
      keyColumn: "jira_issue_key" | "linear_issue_key",
      mappingTable: "jira_project_mappings" | "linear_project_mappings",
      remoteIdColumn: "jira_project_id" | "linear_team_id"
    ) => {
      // Same "scope to the currently mapped entity only" rule as jiraTickets/linearTickets/
      // allTickets, so the stat strip and filter dropdowns never count tickets from a
      // since-switched-away-from project/team alongside the current one.
      const scope = `project_id = $1 AND mapped_remote_id = (SELECT ${remoteIdColumn} FROM ${mappingTable} WHERE project_id = $1 AND enabled = true LIMIT 1)`;
      const stats = await this.db.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM testcases t WHERE t.project_id = src.project_id AND t.${keyColumn} = src.${keyColumn} AND t.deleted_at IS NULL
                ))::int AS covered
         FROM ${table} src WHERE ${scope}`,
        [projectId]
      );
      const types = await this.db.query(`SELECT DISTINCT issue_type FROM ${table} WHERE ${scope} AND issue_type <> '' ORDER BY issue_type`, [projectId]);
      const statuses = await this.db.query(`SELECT DISTINCT status FROM ${table} WHERE ${scope} AND status <> '' ORDER BY status`, [projectId]);
      const total = stats.rows[0]?.total ?? 0;
      const covered = stats.rows[0]?.covered ?? 0;
      return {
        total,
        covered,
        uncovered: total - covered,
        types: types.rows.map((r) => r.issue_type as string),
        statuses: statuses.rows.map((r) => r.status as string)
      };
    };
    const [jira, linear] = await Promise.all([
      bySource("jira_tickets", "jira_issue_key", "jira_project_mappings", "jira_project_id"),
      bySource("linear_tickets", "linear_issue_key", "linear_project_mappings", "linear_team_id")
    ]);
    const all = {
      total: jira.total + linear.total,
      covered: jira.covered + linear.covered,
      uncovered: jira.uncovered + linear.uncovered,
      types: Array.from(new Set([...jira.types, ...linear.types])).sort(),
      statuses: Array.from(new Set([...jira.statuses, ...linear.statuses])).sort()
    };
    return { all, jira, linear };
  }

  async linearComment(projectId: string, userId: string | null | undefined, body: Body) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const organizationId = await this.projectOrganizationId(projectId);
    const connection = await this.getIntegrationConnection(organizationId, "linear", true);
    if (!connection) throw new NotFoundException({ error: "Linear is not connected." });
    const issueKey = String(body.issueKey || body.linearIssueKey || "").trim();
    const comment = String(body.comment || body.body || "").trim();
    if (!issueKey || !comment) throw new BadRequestException({ error: "Linear issue key and comment are required." });
    const linearAuthHeader = this.linearAuthHeader(connection);
    const lookup = await this.linearGraphQL<Body>(linearAuthHeader, "query Issue($id: String!) { issue(id: $id) { id } }", { id: issueKey });
    const issueId = lookup?.issue?.id || issueKey;
    await this.linearGraphQL(
      linearAuthHeader,
      "mutation CreateComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }",
      { issueId, body: comment }
    );
    return { ok: true };
  }

  // Live search against Linear (not the linear_tickets sync cache) — same rationale as jiraSearchIssues.
  async linearSearchIssues(projectId: string, userId: string | null | undefined, query: Body) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const organizationId = await this.projectOrganizationId(projectId);
    const connection = await this.getIntegrationConnection(organizationId, "linear", true);
    if (!connection) throw new NotFoundException({ error: "Linear is not connected." });
    const mappings = await this.db.query(
      "SELECT linear_team_id FROM linear_project_mappings WHERE project_id = $1 AND integration_connection_id = $2 AND enabled = true",
      [projectId, connection.id]
    );
    const teamIds = mappings.rows.map((row) => String(row.linear_team_id)).filter(Boolean);
    if (!teamIds.length) return { list: [] };

    const search = String(query.search || query.q || "").trim();
    const linearAuthHeader = this.linearAuthHeader(connection);
    const results: Body[] = [];
    for (const teamId of teamIds) {
      const data = await this.linearGraphQL<Body>(
        linearAuthHeader,
        `query TeamIssues($teamId: String!, $filter: IssueFilter) {
           team(id: $teamId) {
             issues(first: 20, orderBy: updatedAt, filter: $filter) {
               nodes { id identifier title url state { name } }
             }
           }
         }`,
        { teamId, filter: search ? { title: { containsIgnoreCase: search } } : null }
      );
      for (const issue of normalizeJsonArray(data?.team?.issues?.nodes)) {
        results.push({
          provider: "LINEAR",
          key: String(issue.identifier || ""),
          summary: String(issue.title || ""),
          status: String(issue.state?.name || ""),
          url: String(issue.url || "")
        });
      }
    }
    return { list: results.slice(0, 20) };
  }

  /*
   * Every Zyra route below takes the caller and resolves the project first.
   *
   * None of the read routes did, and neither did settings, close-task or draft-delete: the
   * controller methods had no @Req(). A chat session holds whatever the team told the agent about
   * their product and a task holds the test cases it generated, and both were readable — and
   * mutable — by anyone who knew a project id, from any workspace and with no session at all.
   */
  async zyraAgent(projectId: string, userId: string | null | undefined) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const [project, allocation, usage, tasks, chatActivity] = await Promise.all([
      this.getProject(projectId),
      this.zyraAiAllocation(projectId),
      // Reads the zyra_token_usage ledger, not ai_generation_requests.token_total — that column
      // only ever reflects the task-board flow. The ledger is written by every provider call Zyra
      // makes, chat included, so this total is real usage rather than the permanent 0 a chat-only
      // project used to see. See V87_zyra_token_usage.sql / recordZyraTokenUsage.
      this.db.query<{ total: string }>(
        "SELECT COALESCE(SUM(token_total), 0) AS total FROM zyra_token_usage WHERE project_id = $1",
        [projectId]
      ),
      // chat_session_id IS NULL: a chat-staged review batch's generated_payload holds
      // {opType, draft|fields} wrapper objects, not the flat AiGeneratedDraft shape this board
      // renders — surfacing one here would show a task card with blank title/priority/steps.
      // Chat's own review panel (in the Zyra chat page) is where those get reviewed instead.
      this.db.query(
        `SELECT id, requested_by, provider, model, user_story, acceptance_criteria, custom_prompt, style,
                requested_count, generated_count, generated_payload, saved_count, save_events, created_at, updated_at,
                agent_name, task_status, feedback, context, jira_issue_keys, token_input, token_output, token_total,
                source_summary, activity_log
         FROM ai_generation_requests
         WHERE project_id = $1 AND agent_name = ANY($2::text[]) AND chat_session_id IS NULL
         ORDER BY updated_at DESC LIMIT 50`,
        [projectId, ZYRA_AGENT_NAMES]
      ),
      // Restricted to sessions that actually hold a message, matching has_messages in
      // zyraChatSessions above: opening the chat auto-creates an empty session to type into
      // (ZYU-26/27), and that alone must not read as "last used" any more than an
      // ai_generation_requests row would before a user asked for anything.
      this.db.query<{ last_used: string | null }>(
        `SELECT MAX(s.updated_at) AS last_used
           FROM zyra_chat_sessions s
          WHERE s.project_id = $1
            AND EXISTS (SELECT 1 FROM zyra_chat_messages m WHERE m.session_id = s.id)`,
        [projectId]
      )
    ]);
    const settings = this.parseProjectSettings(project.settings).zyraAgent || {};
    const key = allocation.key;
    // Draft tasks (task-board flow) and chat sessions each carry their own activity
    // timestamp, and only one of the two moves depending on which mode was used — see
    // zyraCreatedTestcaseCount above for the same split. "Last used" is whichever is newer.
    const lastTaskActivity = tasks.rows[0]?.updated_at as string | undefined;
    const lastChatActivity = chatActivity.rows[0]?.last_used ?? undefined;
    const lastUsedAt = [lastTaskActivity, lastChatActivity]
      .filter((v): v is string => Boolean(v))
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null;
    return {
      agent: {
        name: ZYRA_AGENT_NAME,
        role: "AI testcase generation agent",
        active: Boolean(key),
        activationReason: key ? "Workspace AI key allocated to this project." : allocation.reason,
        lastUsedAt
      },
      settings: {
        testcaseCount: Number(settings.testcaseCount || 5),
        testcaseRange: String(settings.testcaseRange || "1-10"),
        capabilities: this.normalizeZyraCapabilities(settings.capabilities)
      },
      aiKey: key
        ? {
            id: key.id,
            name: key.name,
            provider: key.provider,
            defaultModel: key.default_model,
            baseUrl: key.base_url,
            authHeaderName: key.auth_header_name,
            authScheme: key.auth_scheme,
            maskedKey: maskSecret(String(key.api_key || ""))
          }
        : null,
      tokenUsage: {
        total: Number(usage.rows[0]?.total || 0)
      },
      testcasesCreated: await this.zyraCreatedTestcaseCount(projectId),
      tasks: tasks.rows.map((row) => this.formatAiTask(row))
    };
  }

  async testZyraAiConnection(projectId: string, userId: string | null | undefined): Promise<{ ok: boolean; provider: string; model: string; error?: string; latencyMs: number }> {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const allocation = await this.zyraAiAllocation(projectId);
    if (!allocation.key) {
      return { ok: false, provider: "none", model: "none", error: allocation.reason, latencyMs: 0 };
    }
    const { key } = allocation;
    const provider = String(key.provider || "openai").toLowerCase();
    const model = normalizeProviderModel(provider, key.default_model);
    const start = performance.now();
    try {
      // For first-party providers on the default endpoint, probe /v1/models instead of
      // burning an inference call: it validates the key AND proves the configured model
      // is still served, which is exactly the failure an inference probe reports late
      // and obscurely. Custom gateways may not implement it, so they keep the old path.
      if (isCatalogProvider(provider)) {
        const served = await this.fetchProviderModels(provider, String(key.api_key || ""), key.base_url, key.auth_header_name, key.auth_scheme);
        const latencyMs = Math.round(performance.now() - start);
        if (served.length && !served.some((item) => item.id === model)) {
          return {
            ok: false,
            provider,
            model,
            error: `This key can't reach "${model}" — it may have been retired or the account lacks access. Pick another model in Workspace → Integrations.`,
            latencyMs
          };
        }
        return { ok: true, provider, model, latencyMs };
      }
      if (providerWire(provider) === "anthropic") {
        const headers = this.providerAuthHeaders(provider, key.api_key, key.auth_header_name, key.auth_scheme);
        const res = await fetch(normalizeAnthropicMessagesUrlFor(provider, key.base_url), {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: providerModelCandidates(provider, model)[0],
            max_tokens: 5,
            messages: [{ role: "user", content: "hi" }]
          })
        });
        const body = await res.json().catch(() => ({} as Body)) as Body;
        if (!res.ok) {
          const raw = String(body.error?.message || body.error || res.statusText);
          return { ok: false, provider, model, error: this.describeProviderError(provider, res.status, raw) || raw, latencyMs: Math.round(performance.now() - start) };
        }
        return { ok: true, provider, model, latencyMs: Math.round(performance.now() - start) };
      }
      const authHeaders = this.providerAuthHeaders(provider, String(key.api_key || ""), key.auth_header_name, key.auth_scheme);
      const res = await fetch(providerChatUrl(provider, key.base_url, model), {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: "user", content: "hi" }] })
      });
      const body = await res.json().catch(() => ({} as Body)) as Body;
      if (!res.ok) {
        const raw = String(body.error?.message || body.error || res.statusText);
        return { ok: false, provider, model, error: this.describeProviderError(provider, res.status, raw) || raw, latencyMs: Math.round(performance.now() - start) };
      }
      return { ok: true, provider, model, latencyMs: Math.round(performance.now() - start) };
    } catch (err) {
      return { ok: false, provider, model, error: err instanceof Error ? err.message : String(err), latencyMs: Math.round(performance.now() - start) };
    }
  }

  /**
   * How many test cases Zyra has put into this project, across BOTH of its modes.
   *
   * Basecamp 10212918496 ("Zyra Test Generator Displays 0 Tests Generated After Creating 33 Test
   * Cases"): the tile summed `generated_count` over ai_generation_requests, a column only the
   * task-board draft flow ever writes. Chat mode creates test cases directly through
   * applyZyraChatOperations and touches no generation row at all, so every case made by talking to
   * Zyra — which is how the reporter made all 33 — counted as zero.
   *
   * Counted from the `zyra_created` audit action, which both modes now write, and restricted to cases
   * that still exist so deleting a Zyra case takes it back out of the number. DISTINCT because a
   * re-save of the same draft must not count the case twice.
   */
  private async zyraCreatedTestcaseCount(projectId: string): Promise<number> {
    const res = await this.db.query<{ count: string }>(
      `SELECT COUNT(DISTINCT a.entity_id) AS count
         FROM audit_logs a
         JOIN testcases_active t ON t.id::text = a.entity_id
        WHERE a.project_id = $1 AND a.action = 'zyra_created' AND a.entity_type = 'testcase'`,
      [projectId]
    );
    return Number(res.rows[0]?.count || 0);
  }

  /**
   * Logs one provider call's worth of tokens to the zyra_token_usage ledger, backing the "Token
   * usage" tile on Zyra settings (zyraAgent()). Deliberately INSERT-only and a single standalone
   * statement — never combined with another write in one transaction, so it can't introduce a
   * lock-ordering hazard, and a new row's server-generated id never contends with any other
   * transaction's held locks. This is observability, not the critical path: a failure here is
   * logged and swallowed, never allowed to fail the chat reply or generation the caller is waiting
   * on that made the provider call in the first place.
   */
  private async recordZyraTokenUsage(
    projectId: string,
    source: "task_generate" | "task_regenerate" | "chat_router" | "chat_generate" | "chat_plan" | "chat_tool_finalize",
    provider: string,
    model: string,
    usage: { input?: number; output?: number; total?: number }
  ): Promise<void> {
    const input = Number(usage.input || 0);
    const output = Number(usage.output || 0);
    const total = Number(usage.total || input + output);
    if (!total) return;
    try {
      await this.db.query(
        `INSERT INTO zyra_token_usage (project_id, source, provider, model, token_input, token_output, token_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [projectId, source, provider || "unknown", model || "unknown", input, output, total]
      );
    } catch (err) {
      this.logger.warn(`zyra token usage not recorded (${source}, project ${projectId}): ${err instanceof Error ? err.message : err}`);
    }
  }

  async zyraTask(projectId: string, userId: string | null | undefined, taskId: string) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    if (!isUuid(taskId)) throw new NotFoundException({ error: "Zyra task not found" });
    const res = await this.db.query(
      `SELECT id, requested_by, provider, model, user_story, acceptance_criteria, custom_prompt, style,
              requested_count, generated_count, generated_payload, saved_count, save_events, created_at, updated_at,
              agent_name, task_status, feedback, context, jira_issue_keys, token_input, token_output, token_total,
              source_summary, activity_log
       FROM ai_generation_requests
       WHERE id = $1 AND project_id = $2 AND agent_name = ANY($3::text[])`,
      [taskId, projectId, ZYRA_AGENT_NAMES]
    );
    if (!res.rows[0]) throw new NotFoundException({ error: "Zyra task not found" });
    return this.formatAiTask(res.rows[0]);
  }

  async updateZyraSettings(projectId: string, userId: string | null | undefined, body: Body) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const project = await this.getProject(projectId);
    const settings = this.parseProjectSettings(project.settings);
    const current = (settings.zyraAgent || {}) as Body;
    const validRanges = ["minimum", "1-10", "10-30", "all"];
    const testcaseRange = validRanges.includes(String(body.testcaseRange))
      ? String(body.testcaseRange)
      : String(current.testcaseRange || "1-10");
    const { requestedCount } = this.testcaseRangeConfig(testcaseRange);
    // Capabilities: merge the incoming partial over current, then normalize to strict booleans.
    const capabilities = this.normalizeZyraCapabilities({
      ...this.normalizeZyraCapabilities(current.capabilities),
      ...(body.capabilities && typeof body.capabilities === "object" ? body.capabilities : {})
    });
    settings.zyraAgent = { ...current, testcaseCount: requestedCount, testcaseRange, capabilities };
    await this.db.query("UPDATE projects SET settings = $2::jsonb, updated_at = now() WHERE id = $1", [projectId, JSON.stringify(settings)]);
    return { testcaseCount: requestedCount, testcaseRange, capabilities };
  }

  async zyraChatSessions(projectId: string, userId: string | null | undefined) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    // has_messages is additive, not a filter: every session this project ever created is still
    // returned (callers and existing tests rely on a just-created session showing up immediately).
    // It exists so the sidebar can hide sessions nobody ever used without the API silently dropping
    // rows out of its own list.
    const res = await this.db.query(
      `SELECT s.id, s.project_id, s.user_id, s.title, s.created_at, s.updated_at, s.active_plan,
              EXISTS (SELECT 1 FROM zyra_chat_messages m WHERE m.session_id = s.id) AS has_messages
       FROM zyra_chat_sessions s
       WHERE s.project_id = $1
       ORDER BY s.updated_at DESC
       LIMIT 50`,
      [projectId]
    );
    return { list: res.rows.map(toCamel) };
  }

  async zyraChatSession(projectId: string, userId: string | null | undefined, sessionId: string) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    if (!isUuid(sessionId)) throw new NotFoundException({ error: "Chat session not found" });
    const session = await this.db.query(
      "SELECT id, project_id, user_id, title, created_at, updated_at, active_plan FROM zyra_chat_sessions WHERE id = $1 AND project_id = $2",
      [sessionId, projectId]
    );
    if (!session.rows[0]) throw new NotFoundException({ error: "Zyra chat session not found" });
    const messages = await this.db.query(
      `SELECT id, session_id, project_id, user_id, role, content, reasoning_summary, action_type,
              status, testcases, activity, created_at, review_request_id
       FROM zyra_chat_messages
       WHERE session_id = $1 AND project_id = $2
       ORDER BY created_at ASC`,
      [sessionId, projectId]
    );
    return {
      ...toCamel(session.rows[0]),
      messages: messages.rows.map((row) => {
        const item = toCamel(row);
        item.testcases = normalizeJsonArray(row.testcases);
        item.activity = normalizeJsonArray(row.activity);
        return item;
      })
    };
  }

  async createZyraChatSession(projectId: string, userId: string | null | undefined, body: Body) {
    // The caller was passed in but never checked: an anonymous request opened a session with a null
    // user_id in any project by id, and a member of one project could open a chat in another.
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    const title = String(body.title || "Zyra chat").trim().slice(0, 240) || "Zyra chat";
    const res = await this.db.query(
      `INSERT INTO zyra_chat_sessions (project_id, user_id, title)
       VALUES ($1,$2,$3)
       RETURNING id, project_id, user_id, title, created_at, updated_at`,
      [projectId, userId || null, title]
    );
    return { ...toCamel(res.rows[0]), messages: [] };
  }

  async sendZyraChatMessage(projectId: string, userId: string | null | undefined, sessionId: string, body: Body) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    if (!isUuid(sessionId)) throw new NotFoundException({ error: "Zyra chat session not found" });
    const message = String(body.message || "").trim();
    if (!message) throw new BadRequestException({ error: "message is required" });
    const sessionRes = await this.db.query("SELECT * FROM zyra_chat_sessions WHERE id = $1 AND project_id = $2", [sessionId, projectId]);
    if (!sessionRes.rows[0]) throw new NotFoundException({ error: "Zyra chat session not found" });

    // id is returned because it seeds this turn's Langfuse trace id (see startZyraTurn). It is the
    // only stable identifier for the turn: seeding off the message text instead would give two
    // identical messages in one session the same deterministic trace id, collapsing both turns
    // into one trace.
    const userMessageRes = await this.db.query(
      `INSERT INTO zyra_chat_messages (session_id, project_id, user_id, role, content, status)
       VALUES ($1,$2,$3,'user',$4,'sent')
       RETURNING id`,
      [sessionId, projectId, uid, message]
    );
    const userMessageId = String(userMessageRes.rows[0]?.id ?? "");

    // A paused plan (stopped by the user, or paused after a batch failure) can be picked
    // back up with a plain "continue" — resolved before any other decision-making so it
    // doesn't get treated as a normal analytical question.
    const existingPlan = sessionRes.rows[0].active_plan as Body | undefined;
    if (existingPlan?.status === "paused" && this.isZyraResumeIntent(message)) {
      const resumed = await this.resumeZyraChatPlan(projectId, uid, sessionId);
      const lastMessage = resumed.messages[resumed.messages.length - 1];
      return { message: lastMessage, session: resumed };
    }
    // Any other new message supersedes an in-flight or paused plan — the background loop
    // checks the plan id before each batch and stops once it no longer matches (see
    // continueZyraChatPlan).
    if (existingPlan) {
      await this.db.query("UPDATE zyra_chat_sessions SET active_plan = NULL WHERE id = $1", [sessionId]);
    }
    // A genuinely new message means the user has moved on from whatever turn timed out earlier in
    // this session — expire any dangling checkpoint so Continue can no longer resolve to context this
    // message has superseded. Deliberately scoped to 'timed_out' only: a checkpoint a concurrent
    // continueZyraChatMessage call has already claimed (status 'resuming') is left alone so that
    // in-flight resume can still finish and post its own message — see continueZyraChatMessage.
    await this.db.query("UPDATE zyra_chat_messages SET status = 'expired' WHERE session_id = $1 AND status = 'timed_out'", [sessionId]);

    const decision = await this.buildZyraChatDecision(projectId, uid, sessionId, message, userMessageId);
    const applied = await this.applyZyraChatOperations(projectId, uid, sessionId, decision.operations);
    const activity = [
      { actor: "user", title: "Asked Zyra", detail: message.slice(0, 320), createdAt: new Date().toISOString() },
      ...applied.activity
    ];
    const testcases = applied.testcases.length ? applied.testcases : decision.testcases;
    if (decision.actionType === "create" && applied.testcases.length) {
      const ids = applied.testcases.map((tc) => tc.id).filter(Boolean);
      await this.db.query(
        "UPDATE zyra_chat_sessions SET last_completed_plan = $2::jsonb WHERE id = $1",
        [sessionId, JSON.stringify({ testcaseIds: ids, totalCount: ids.length })]
      );
    }
    const item = await this.insertZyraAssistantMessage({ sessionId, projectId, uid, decision, applied, testcases, activity });
    const title = this.compactTitle(message);
    await this.db.query(
      "UPDATE zyra_chat_sessions SET title = CASE WHEN title = 'Zyra chat' THEN $3 ELSE title END, updated_at = now() WHERE id = $1 AND project_id = $2",
      [sessionId, projectId, title]
    );
    return { message: item, session: await this.zyraChatSession(projectId, userId, sessionId) };
  }

  /*
   * Shared by sendZyraChatMessage and continueZyraChatMessage — the only two places an assistant
   * turn is ever written. One place means the column list (and the timed_out/resume_checkpoint
   * branch) can't drift between a fresh turn and a resumed one.
   */
  private async insertZyraAssistantMessage(params: {
    sessionId: string;
    projectId: string;
    uid: string;
    decision: ZyraChatDecision;
    applied: ZyraAppliedOperations;
    testcases: Body[];
    activity: Body[];
  }): Promise<Body> {
    const { sessionId, projectId, uid, decision, applied, testcases, activity } = params;
    const status = decision.timedOut ? "timed_out" : "completed";
    const resumeCheckpoint = decision.timedOut && decision.resumeCheckpoint ? JSON.stringify(decision.resumeCheckpoint) : null;
    const assistant = await this.db.query(
      `INSERT INTO zyra_chat_messages
       (session_id, project_id, user_id, role, content, reasoning_summary, action_type, status, testcases, activity, review_request_id, resume_checkpoint)
       VALUES ($1,$2,$3,'assistant',$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11::jsonb)
       RETURNING id, session_id, project_id, user_id, role, content, reasoning_summary, action_type, status, testcases, activity, created_at, review_request_id`,
      [
        sessionId,
        projectId,
        uid,
        this.finalizeZyraChatReply(decision, applied, testcases),
        decision.reasoningSummary,
        decision.actionType,
        status,
        JSON.stringify(testcases),
        JSON.stringify(activity),
        applied.reviewRequestId || null,
        resumeCheckpoint
      ]
    );
    const item = toCamel(assistant.rows[0]);
    item.testcases = normalizeJsonArray(assistant.rows[0].testcases);
    item.activity = normalizeJsonArray(assistant.rows[0].activity);
    return item;
  }

  /*
   * Picks a timed-out turn back up. Basecamp-reported symptom: the provider stalled, the request
   * held open with no reply and no error, indistinguishable from "Zyra doesn't respond" (see
   * ZYRA_ROUTER_TIMEOUT_MS/ZYRA_GENERATE_TIMEOUT_MS). This is what the chat's Continue button calls.
   *
   * Race safety: the UPDATE ... WHERE status = 'timed_out' below is the only thing that decides who
   * gets to resume a given checkpoint. It is a single atomic statement, so a double-click or two
   * browser tabs hitting this at once can only have one request see rowCount 1 — the other sees 0 and
   * is treated as "already resumed" rather than erroring, which is the correct answer for a UI action
   * a user might reasonably fire twice. sendZyraChatMessage separately expires a checkpoint the moment
   * the user sends a new message, so Continue can never resolve to a turn the conversation has since
   * moved past.
   */
  async continueZyraChatMessage(projectId: string, userId: string | null | undefined, sessionId: string, messageId: string) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    if (!isUuid(sessionId) || !isUuid(messageId)) throw new NotFoundException({ error: "Zyra chat message not found" });

    const claim = await this.db.query(
      `UPDATE zyra_chat_messages SET status = 'resuming'
       WHERE id = $1 AND session_id = $2 AND project_id = $3 AND status = 'timed_out'
       RETURNING resume_checkpoint`,
      [messageId, sessionId, projectId]
    );
    if (!claim.rows[0]) {
      // Not (or no longer) claimable: already resumed by an earlier click, currently being resumed by
      // a concurrent one, expired by a newer message, or never existed. None of these are errors the
      // user caused right now — hand back the current session so the UI just reflects reality.
      const existing = await this.db.query("SELECT 1 FROM zyra_chat_messages WHERE id = $1 AND session_id = $2 AND project_id = $3", [messageId, sessionId, projectId]);
      if (!existing.rows[0]) throw new NotFoundException({ error: "Zyra chat message not found" });
      return { message: null, session: await this.zyraChatSession(projectId, userId, sessionId) };
    }

    const checkpoint = (claim.rows[0].resume_checkpoint || {}) as Partial<ZyraResumeCheckpoint>;
    const resumeMessage = String(checkpoint.message || "");
    const checkpointUserMessageId = String(checkpoint.userMessageId || "") || undefined;
    if (!resumeMessage) {
      // A checkpoint with no message text is unusable — revert rather than strand it in 'resuming'.
      await this.db.query("UPDATE zyra_chat_messages SET status = 'timed_out' WHERE id = $1 AND status = 'resuming'", [messageId]);
      throw new BadRequestException({ error: "This turn has no context to resume from — send a new message instead." });
    }

    try {
      const decision = checkpoint.stage === "generate"
        ? await this.buildZyraChatDecision(projectId, uid, sessionId, resumeMessage, checkpointUserMessageId, {
            routedSuite: checkpoint.routedSuite ?? null,
            routedCount: checkpoint.routedCount ?? {}
          })
        : await this.buildZyraChatDecision(projectId, uid, sessionId, resumeMessage, checkpointUserMessageId);
      const applied = await this.applyZyraChatOperations(projectId, uid, sessionId, decision.operations);
      const activity = [
        { actor: "user", title: "Continued after timeout", detail: resumeMessage.slice(0, 320), createdAt: new Date().toISOString() },
        ...applied.activity
      ];
      const testcases = applied.testcases.length ? applied.testcases : decision.testcases;
      if (decision.actionType === "create" && applied.testcases.length) {
        const ids = applied.testcases.map((tc) => tc.id).filter(Boolean);
        await this.db.query(
          "UPDATE zyra_chat_sessions SET last_completed_plan = $2::jsonb WHERE id = $1",
          [sessionId, JSON.stringify({ testcaseIds: ids, totalCount: ids.length })]
        );
      }
      const item = await this.insertZyraAssistantMessage({ sessionId, projectId, uid, decision, applied, testcases, activity });
      // Terminal — this checkpoint has now produced its follow-up message and cannot be resumed
      // again. A fresh timeout (decision.timedOut again) instead lands on the NEW message's own
      // resume_checkpoint, so Continue keeps working across repeated timeouts.
      await this.db.query("UPDATE zyra_chat_messages SET status = 'resumed' WHERE id = $1 AND status = 'resuming'", [messageId]);
      return { message: item, session: await this.zyraChatSession(projectId, userId, sessionId) };
    } catch (err) {
      // Anything that throws here (not a timeout — those are caught inside buildZyraChatDecision and
      // returned as another timed-out decision, not thrown) leaves this checkpoint resumable again
      // rather than stranding it in 'resuming' forever.
      await this.db.query("UPDATE zyra_chat_messages SET status = 'timed_out' WHERE id = $1 AND status = 'resuming'", [messageId]);
      throw err;
    }
  }

  // Lets the user cut short a batched "all possible cases" plan. A batch already in flight
  // when this is called can't be aborted mid-request — it still finishes and posts its own
  // message — but continueZyraChatPlan checks active_plan before starting the next batch.
  // This pauses (rather than discards) the plan, preserving remainingScenarios/doneCount so
  // resumeZyraChatPlan — or just typing "continue" — can pick it back up later.
  async stopZyraChatPlan(projectId: string, userId: string | null | undefined, sessionId: string) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    if (!isUuid(sessionId)) throw new NotFoundException({ error: "Zyra chat session not found" });
    const sessionRes = await this.db.query("SELECT active_plan FROM zyra_chat_sessions WHERE id = $1 AND project_id = $2", [sessionId, projectId]);
    if (!sessionRes.rows[0]) throw new NotFoundException({ error: "Zyra chat session not found" });
    const plan = sessionRes.rows[0].active_plan as Body | undefined;
    if (plan && plan.status !== "paused") {
      const doneCount = Number(plan.doneCount || 0);
      const totalCount = Number(plan.totalCount || 0);
      await this.db.query(
        "UPDATE zyra_chat_sessions SET active_plan = $2::jsonb WHERE id = $1",
        [sessionId, JSON.stringify({ ...plan, status: "paused" })]
      );
      await this.postZyraPlanMessage(
        projectId,
        sessionId,
        uid,
        `Stopped at your request — ${doneCount}/${totalCount} scenarios covered. Say "continue" any time and I'll pick back up with the remaining ${totalCount - doneCount}.`,
        [],
        []
      );
    }
    return this.zyraChatSession(projectId, userId, sessionId);
  }

  private isZyraResumeIntent(message: string): boolean {
    return /\b(continue|resume|keep going|carry on|go ahead|proceed|pick up where)\b/i.test(message);
  }

  // Reactivates a paused plan under a fresh planId (so any stale in-flight batch from before
  // the pause can never collide with the resumed loop) and hands it back to
  // continueZyraChatPlan. No-ops quietly if there's nothing paused to resume.
  async resumeZyraChatPlan(projectId: string, userId: string | null | undefined, sessionId: string) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    if (!isUuid(sessionId)) throw new NotFoundException({ error: "Zyra chat session not found" });
    const sessionRes = await this.db.query("SELECT active_plan FROM zyra_chat_sessions WHERE id = $1 AND project_id = $2", [sessionId, projectId]);
    if (!sessionRes.rows[0]) throw new NotFoundException({ error: "Zyra chat session not found" });
    const plan = sessionRes.rows[0].active_plan as Body | undefined;
    const remainingScenarios = normalizeJsonArray(plan?.remainingScenarios).map(String);
    if (!plan || plan.status !== "paused" || !remainingScenarios.length) {
      return this.zyraChatSession(projectId, userId, sessionId);
    }
    const planId = randomUUID();
    const doneCount = Number(plan.doneCount || 0);
    const totalCount = Number(plan.totalCount || 0);
    await this.db.query(
      "UPDATE zyra_chat_sessions SET active_plan = $2::jsonb, updated_at = now() WHERE id = $1",
      [sessionId, JSON.stringify({ ...plan, planId, status: "running" })]
    );
    await this.postZyraPlanMessage(
      projectId,
      sessionId,
      uid,
      `Resuming — ${doneCount}/${totalCount} scenarios covered so far, continuing with the remaining ${remainingScenarios.length}.`,
      [],
      []
    );
    void this.continueZyraChatPlan(projectId, uid, sessionId, planId).catch(() => undefined);
    return this.zyraChatSession(projectId, userId, sessionId);
  }

  // One AI call understands the request, then the system executes it. There is deliberately no
  // keyword router in front of the model: a regex table cannot tell "start generating" from
  // "generate", or know that "save it" means create-these when the cases were never written and
  // move-these when they were. What the model gets instead of a keyword hint is *state* — which
  // of its own previous turns actually persisted testcases (see zyraTranscript) — and what the
  // system does with the answer is validated, capability-gated, and reconciled against reality
  // (applyZyraChatOperations, reconcileZyraReply). The model decides; it never writes.
  private async buildZyraChatDecision(
    projectId: string,
    userId: string,
    sessionId: string,
    message: string,
    userMessageId?: string,
    // Set only by continueZyraChatMessage, when the router already resolved this turn to a create
    // before the drafting call timed out. Its presence skips the router call entirely — that is the
    // whole point of resuming rather than restarting: the routing decision the user already waited
    // for is not repeated.
    resume?: { routedSuite: { id?: string; name?: string } | null; routedCount: { requestedCount?: unknown; exhaustive?: boolean } }
  ): Promise<ZyraChatDecision> {
    const jiraKeyResolution = await this.resolveJiraIssueKeysDetailed(projectId, message);
    const mentionedJiraKeys = jiraKeyResolution.keys;
    const [history, knowledgeFallback, ragDiagnostics, folderKnowledge, existingTestcases, allocation, projectSnapshot, mentionedJira, lastCompletedPlanRes] = await Promise.all([
      this.db.query(
        `SELECT role, content, reasoning_summary, action_type, testcases
         FROM zyra_chat_messages
         WHERE session_id = $1 AND project_id = $2
         ORDER BY created_at DESC
         LIMIT 12`,
        [sessionId, projectId]
      ),
      this.knowledgeSnapshot(projectId),
      // Semantic (embeddings) retrieval, run in parallel with the always-cheap recency
      // fallback above so a project with nothing embedded yet (or an Anthropic-only key)
      // pays no extra latency — retrieveKnowledgeContext never throws, resolves to [] on
      // any failure.
      // retrieveWithDiagnostics rather than retrieveKnowledgeContext: the plain call returns [] for
      // every failure mode, so "no embeddings key" and "nothing relevant" are indistinguishable —
      // which is how the vector half of this search stayed off in production unnoticed.
      this.ragRetrieval.retrieveWithDiagnostics(projectId, message),
      // Direct folder-name lookup — recency/embeddings never match on a folder's name alone
      // (e.g. "knowledge base 'EAD-11215' folder"), only on document content.
      this.knowledgeFolderSnapshot(projectId, message, mentionedJiraKeys),
      this.existingTestcaseSnapshot(projectId, message, ""),
      this.zyraAiAllocation(projectId),
      this.zyraChatProjectSnapshot(projectId),
      // Relevance-matched, not just explicitly-named: a request that never types an issue key still
      // needs the tickets it is about (see relevantJiraSnapshot).
      this.relevantJiraSnapshot(projectId, message, mentionedJiraKeys),
      this.db.query("SELECT last_completed_plan FROM zyra_chat_sessions WHERE id = $1", [sessionId]).catch(() => ({ rows: [] as Body[] }))
    ]);
    const ragKnowledge = ragDiagnostics.items;
    const usedRecencyFallback = !ragKnowledge.length;
    const knowledge = [...folderKnowledge, ...(ragKnowledge.length ? ragKnowledge : knowledgeFallback)];

    // Opened once the gathered context exists, so the trace carries what Zyra actually read rather
    // than only what it later claims to have read.
    // The trace id is createTraceId(zyra_chat_messages.id), so a support report ("Zyra did the
    // wrong thing on this message") maps to its trace by recomputing the id from the row — no
    // trace_id column and no backfill. Falls back to the session only for the callers that have
    // no message row of their own.
    const trace = await startZyraTurn({
      messageId: userMessageId || `${sessionId}:${Date.now()}`,
      sessionId,
      projectId,
      userId,
      message
    });
    recordJiraContext(trace, {
      extracted: jiraKeyResolution.extracted,
      validated: jiraKeyResolution.keys,
      configuredProjectKeys: jiraKeyResolution.configuredProjectKeys,
      resolved: mentionedJira.map((ticket) => ({ key: ticket.key, source: "cache" as const, summary: ticket.summary })),
      relevanceMatched: mentionedJira.map((ticket) => ticket.key).filter((key) => !jiraKeyResolution.keys.includes(key))
    });
    recordKnowledgeContext(trace, {
      query: message,
      semanticSearchRan: ragDiagnostics.semanticSearchRan,
      reason: ragDiagnostics.reason,
      retrieved: (ragKnowledge.length ? ragKnowledge : knowledgeFallback).map((item) => ({
        title: String((item as Body).title || ""),
        sourceType: String(((item as Body).citation as Body)?.sourceType || ""),
        sourceId: String(((item as Body).citation as Body)?.sourceId || ""),
        score: typeof (item as Body).score === "number" ? Number((item as Body).score) : undefined
      })),
      folderMatched: folderKnowledge.map((item) => ({ title: String((item as Body).title || "") })),
      fallbackUsed: usedRecencyFallback
    });
    recordExistingCoverage(trace, {
      searchTerms: this.zyraSearchTerms(message),
      testcases: existingTestcases.map((tc) => ({ externalId: String((tc as Body).externalId || ""), title: String((tc as Body).title || "") }))
    });
    const lastCompletedPlanCount = normalizeJsonArray((lastCompletedPlanRes.rows[0]?.last_completed_plan as Body | undefined)?.testcaseIds).length;
    // Oldest-first: the transcript handed to the model must read in conversation order.
    const chronologicalHistory = [...history.rows].reverse();
    const key = allocation.key;
    if (!key) {
      return this.zyraDegradedDecision(message, existingTestcases, allocation.reason);
    }

    const provider = String(key.provider || "openai").toLowerCase();
    const model = normalizeProviderModel(provider, key.default_model);
    const zyraAgentSettings = await this.zyraAgentSettings(projectId);
    const capabilities = this.normalizeZyraCapabilities(zyraAgentSettings.capabilities);
    const projectTestcaseRange = String(zyraAgentSettings.testcaseRange || "1-10");
    const knowledgeForChat = capabilities.knowledgeBase ? knowledge : [];
    const context = [
      "You are Zyra, an expert test engineer and edge-case designer for this product.",
      "Your workflow is: understand the user's query, decide which project context is needed, choose exactly one supported action, then return a structured plan.",
      `Enabled capabilities for this project — generation (author new testcases): ${capabilities.generation ? "ON" : "OFF"}; knowledge base access: ${capabilities.knowledgeBase ? "ON" : "OFF"}; testcase storage (create/update/archive/bulk): ${capabilities.testcaseStorage ? "ON" : "OFF"}; suite operations (create/move): ${capabilities.suiteOperations ? "ON" : "OFF"}.`,
      `Configured test case volume for this project: "${projectTestcaseRange}" (${this.testcaseRangeConfig(projectTestcaseRange).instruction}). This is the default when the user does not ask for a specific number — do not promise or propose a count that contradicts it, and do not report requestedCount unless the user actually named one.`,
      "Before proposing or authoring anything, ground yourself in the context below: the knowledge base (semantic retrieval plus any folder the user named), the Jira tickets, and the existing testcases. Coverage answers must be based on the existing testcases shown, never guessed; new testcases must fill gaps in that coverage rather than duplicate it. Say which sources you used in reasoningSummary.",
      "If the user asks for an action whose capability is OFF, do NOT emit those operations — choose action 'answer' and briefly say that capability is disabled in Zyra settings and how to enable it. Never silently substitute a different mutation (e.g. do not create testcases when storage or generation is OFF).",
      "Supported actions:",
      "- answer: answer product, feature, test strategy, or knowledge-base questions conversationally.",
      "- list: show existing testcase or coverage rows when the user asks to show/list/compare coverage.",
      "- jira_pending_testcases: count Jira tickets, linked testcase coverage, and pending tickets for testcase writing.",
      "- create: create new testcase drafts/saved cases only when the user clearly asks to create/generate/add/write testcases. If the user names an existing suite for these new testcases (or a prior turn already established one, e.g. confirming 'yes' to save into the suite you just discussed), set operation.suiteId (preferred, from 'Existing suites' below) or operation.suiteName directly on the create operation so the testcase lands in that suite immediately — do not require a separate move_to_suite step for testcases you are creating in this same turn.",
      "- update: update an existing testcase only when the user clearly asks to update/edit/mark/revise a testcase.",
      "- archive: archive an existing testcase when the user asks to remove/delete/archive testcase coverage. IMPORTANT: before archiving, always describe which testcases will be archived and explicitly ask the user to confirm (e.g. 'I found TC-5 Login Test. Should I archive it? Reply yes to confirm.'). Only include archive operations if the user's current message is a clear confirmation (yes, confirm, go ahead, proceed) after you already proposed what would be archived in the prior assistant turn.",
      "- create_suite: create a new test suite (a folder/group for testcases) when the user asks to create/add a suite, folder, or group. Put the suite name in operation.suiteName.",
      "- move_to_suite: move/assign EXISTING testcases into a suite when the user asks to move/assign/organize/group/put existing testcases into a suite. The target suite goes in operation.suiteName (it is created automatically if it does not already exist, so you do not need a separate create_suite op for the same suite). List the testcases to move in operation.externalIds (use the external IDs shown under 'Existing suites' / 'Existing testcases'), set operation.allExisting=true when the user means every existing testcase, or set operation.fromLastPlan=true when the user refers to 'all'/'the N cases' from a recent generation batch (see 'Most recently generated batch' below) — fromLastPlan is exact and does not depend on you correctly recalling every external ID from earlier in the conversation, so prefer it over externalIds whenever the user is clearly referring to a just-generated batch rather than naming specific unrelated testcases.",
      "CRITICAL: 'create'/'update'/'archive' operations are STAGED for review, not applied immediately — nothing is inserted, changed, or removed in the repository until the user separately reviews and saves the staged batch. Still emit the operation as soon as you are confident the user wants it — do not add an extra 'would you like me to save these?' round-trip of your own in the chat, the review step already exists downstream and is not yours to gate. But your WORDING must match reality: describe what you produce as DRAFTED/PROPOSED and staged for review — never as 'created', 'saved', 'updated', or 'archived' (all past tense, all claims about work this turn did not do), however many testcases your reply text lists. If the user wants testcases, choose 'create' now; otherwise do not enumerate any as if they existed.",
      `What you create is staged as a draft pending the user's review — it does not exist in the repository yet. Once saved it lands with status Draft, in the suite the request named, or in "${LegacyService.ZYRA_DRAFT_SUITE_NAME}" if it named none. So say where it WILL be filed once saved, never where it "is" — nothing you create this turn is openable or runnable until the user reviews and saves it.`,
      `"Save them" / "save them to <suite>" AFTER you have already drafted testcases is a move, not a create: emit move_to_suite with fromLastPlan=true and the target suiteName. Re-creating them would duplicate every case. Use the transcript annotations to tell the two apart — if the previous turn saved rows, they exist and must be moved; if it saved nothing, they do not exist yet and 'save them' means create.`,
      "A short confirmation of an offer you made in your previous turn ('yes', 'yes please', 'go ahead', 'do it', 'please start generating', 'save it', 'save them into <suite>') is a create request: choose 'create', and set suiteName/suiteId on the create operation when a suite is named.",
      "Only use move_to_suite for testcases that appear under 'Existing suites'/'Existing testcases' below, or in the most recently generated batch. If the user asks you to save or file testcases that so far only appeared as text in this chat, those testcases DO NOT EXIST yet — choose 'create' with the suite named on the create operation, never move_to_suite.",
      "CRITICAL: moving or assigning existing testcases into a suite is NEVER a create action. Do not generate, draft, or duplicate testcases for a move/assign/organize request — only emit move_to_suite operations that reference the existing testcases. Use create only when the user explicitly asks to author brand-new testcases.",
      "When the user asks to create a suite AND move existing testcases into it in one message, return a single move_to_suite operation with the suiteName (the suite is auto-created) — or a create_suite plus move_to_suite — but never any create operations.",
      "Use the project snapshot to choose the action. If the query asks for numbers from Jira/testcase links, choose jira_pending_testcases instead of guessing.",
      "If the user asks a normal product, feature, explanation, example, or how-to question, choose answer with empty operations and empty testcases.",
      "Only return testcase rows when the user explicitly asks to create, update, archive/remove, list, compare, or show testcase coverage.",
      "Only create/update/archive when the user clearly asks for a repository mutation. Otherwise suggest what could be done without mutating anything.",
      "Do not reveal hidden chain-of-thought. Provide a concise reasoningSummary with observable factors and action steps.",
      "Treat remove/delete requests as archive operations unless the user clearly names an existing app delete control.",
      "A hypothetical or exploratory question ('what would happen if…', 'should we remove…', 'how many could we archive') is always action 'answer' with empty operations. Only act when the user is asking for the action itself.",
      "You are the only thing that decides what this request means — there is no keyword matcher behind you, and an 'answer' costs the user their request. Read the whole conversation: resolve pronouns ('it', 'those', 'them'), confirmations ('yes', 'go ahead', 'please start generating'), and follow-ups ('now put them in a suite') against what was actually said and done. Each assistant turn in the transcript below is annotated with what it actually persisted, so use those annotations — not your own earlier wording — to decide whether testcases the user is referring to already exist.",
      "For a create request also report how many testcases the user asked for: set requestedCount to that number when they named one (in digits or words, e.g. 'fifteen' -> 15), and set exhaustive=true when they asked for everything ('all possible cases', 'as many as you can', 'full coverage'). Leave requestedCount null and exhaustive false when they did not say — the project's configured range is used then.",
      "Return ONLY a single valid JSON object — no markdown fences, no text before or after the JSON:",
      "{\"reply\":\"\",\"reasoningSummary\":\"\",\"action\":\"answer|list|jira_pending_testcases|create|update|archive|create_suite|move_to_suite\",\"actionType\":\"answer|create|update|archive|suite|mixed\",\"requestedCount\":null,\"exhaustive\":false,\"operations\":[{\"type\":\"create|update|archive|create_suite|move_to_suite\",\"testcaseId\":\"\",\"externalId\":\"\",\"externalIds\":[],\"allExisting\":false,\"fromLastPlan\":false,\"suiteName\":\"\",\"suiteId\":\"\",\"draft\":{},\"fields\":{},\"reason\":\"\"}],\"testcases\":[{}]}",
      "REPLY FIELD RULES — reply is rendered as markdown in a chat UI, must be human-readable:",
      "  - Use ## for main headings, ### for subsections, **bold** for emphasis, - for bullets, 1. for numbered steps.",
      "  - For comparisons or tabular data use markdown table syntax: | Heading | Heading |\\n|---|---|\\n| value | value |",
      "  - TEST CASES GO IN THE testcases ARRAY, NEVER IN reply. The UI renders that array as a table with id, title, priority, status and steps. reply gets a one-or-two-line summary only (e.g. 'Created 3 test cases covering the checkout flow.'). A markdown table of test cases in reply is stripped out before the user sees it, so writing one loses the content — put the rows in the array instead. Tables of other things (coverage per module, Jira comparisons) are fine in reply.",
      "  - NEVER put raw JSON, object/array literals, code blocks, or placeholder text like <string> in reply.",
      "  - JSON STRING ESCAPING IS MANDATORY: every double quote inside reply must be written as \\\" and every line break as \\n. An unescaped quote or a literal newline makes the whole response unparseable. Prefer 'single quotes' for quoted phrases so this cannot happen.",
      "  - Be direct — skip filler openers like 'Certainly!', 'Sure!', or 'Here is your answer:'.",
      "  - For analytical responses (coverage gaps, test strategy, explanations) use structured headings and bullets so the answer is easy to scan.",
      "",
      `Existing suites (use these names/ids for move_to_suite; reuse an existing suite instead of duplicating it). "${LegacyService.ZYRA_DRAFT_SUITE_NAME}" is where your own unfiled drafts are staged — its count is how many test cases you have generated that nobody has filed yet, so use it when asked how many you have created:`,
      projectSnapshot.suites.length ? projectSnapshot.suites.map((s) => `${s.name} (id: ${s.id}, ${s.testCaseCount} testcase(s))`).join("\n") : "No suites yet.",
      projectSnapshot.unassignedTestCaseCount > 0
        ? `Unassigned (no suite) (${projectSnapshot.unassignedTestCaseCount} testcase(s)) — not attached to any suite above.`
        : "",
      `The total test case count for this project is ${projectSnapshot.testcaseCount}, equal to the suite counts above plus Unassigned. ALWAYS include the Unassigned row in any suite-wise or per-suite breakdown you give — never report a breakdown whose rows sum to less than the total without accounting for the difference.`,
      "",
      "Most recently generated batch (already saved to the repository; use move_to_suite with fromLastPlan=true to reference all of these together):",
      lastCompletedPlanCount ? `${lastCompletedPlanCount} testcase(s) tracked from the last generation batch in this session.` : "No tracked batch yet in this session — nothing has been generated and saved here, so there is no batch to move or file.",
      "",
      "Project snapshot:",
      JSON.stringify(projectSnapshot),
      "",
      "Knowledge base:",
      capabilities.knowledgeBase
        ? (knowledgeForChat.map((item) => `${item.title}\n${item.content}`).join("\n\n") || "No knowledge-base notes.")
        : "Knowledge base access is disabled for Zyra in this project — do not rely on or claim knowledge-base context.",
      "",
      "Jira tickets relevant to this request (keys the user named, plus the closest matches from the synced Jira cache). Every synced ticket is also mirrored into the knowledge base above as a 'KEY: summary' document, so Jira context can reach you through either section:",
      mentionedJira.map((item) => `${item.key}: ${item.summary}\n${item.description}`).join("\n\n")
        || "No Jira ticket matched this request. Do not conclude Jira is disconnected from this — say so only if the project snapshot shows no Jira tickets at all.",
      "",
      "Existing testcases:",
      existingTestcases.map((tc) => `${tc.externalId} | ${tc.title} | ${tc.priority} | ${tc.status}\n${tc.description}\nSteps: ${tc.stepsSummary}`).join("\n\n") || "No existing testcases.",
      "",
      "Recent chat (each assistant turn is annotated with what it actually wrote to the repository —",
      "trust the annotation over the wording of the reply, which may describe testcases that were never saved):",
      this.zyraTranscript(chronologicalHistory)
    ].join("\n");

    // Resuming a turn whose drafting call already timed out once the router had resolved it — skip
    // the router call entirely (see the `resume` param doc) and go straight to generation with the
    // suite/count it already decided. `context` above still gets built even though it goes unused
    // here; keeping this branch a plain early-return, rather than restructuring the whole function
    // around it, is what keeps the diff against the non-resume path small enough to trust.
    if (resume) {
      if (!capabilities.generation) return this.zyraCapabilityDisabled("generation", existingTestcases.length);
      return this.zyraHandleChatCreate({
        projectId,
        userId,
        sessionId,
        provider,
        model,
        key,
        message,
        userMessageId,
        knowledgeForChat,
        existingTestcases,
        mentionedJiraKeys,
        projectTestcaseRange,
        suites: projectSnapshot.suites,
        conversation: this.zyraTranscript(chronologicalHistory),
        routedSuite: resume.routedSuite,
        routedCount: resume.routedCount,
        mentionedJira,
        capabilities
      });
    }

    try {
      const raw = providerWire(provider) === "anthropic"
        ? await this.zyraChatWithAnthropic(key, model, context, message)
        : await this.zyraChatWithOpenAi(key, model, context, message);
      // Real provider usage (raw.__zyraUsage) rather than the estimateTokens() guess the Langfuse
      // trace below still uses for its own, separate purpose.
      await this.recordZyraTokenUsage(projectId, "chat_router", provider, model, raw.__zyraUsage || {});
      const modelIntent = this.intentFromZyraModelAction(raw.action, raw.actionType);
      // The router call itself: the prompt the model saw and the structured decision it returned.
      // Recorded before dispatch so a decision that is later overridden by a capability gate is
      // still visible as what the model actually chose.
      recordGeneration(trace, {
        name: "router",
        provider,
        model,
        input: { message, context },
        output: raw,
        usage: { input: estimateTokens(context) + estimateTokens(message), output: estimateTokens(JSON.stringify(raw ?? "")) }
      });
      endZyraTurn(trace, {
        reply: String(raw.reply || ""),
        actionType: modelIntent,
        operationsRequested: normalizeJsonArray(raw.operations).length
      });
      if (modelIntent === "jira_pending_testcases") {
        const toolDecision = await this.analyzeZyraJiraTestcaseCoverage(projectId);
        return this.finalizeZyraToolDecisionWithAi({
          projectId,
          key,
          provider,
          model,
          message,
          context,
          toolName: "jira_pending_testcases",
          toolDecision
        });
      }
      if (modelIntent === "suite" && !capabilities.suiteOperations) {
        return this.zyraCapabilityDisabled("suiteOperations", existingTestcases.length);
      }
      if ((modelIntent === "update" || modelIntent === "archive") && !capabilities.testcaseStorage) {
        return this.zyraCapabilityDisabled("testcaseStorage", existingTestcases.length);
      }
      if (modelIntent === "create") {
        if (!capabilities.generation) return this.zyraCapabilityDisabled("generation", existingTestcases.length);
        // The router picked create but does not author the drafts — generation is its own call,
        // handed off to zyraHandleChatCreate (shared with continueZyraChatMessage's resume-from-
        // generate path, so a timeout here and a timeout on resume are handled identically).
        return this.zyraHandleChatCreate({
          projectId,
          userId,
          sessionId,
          provider,
          model,
          key,
          message,
          userMessageId,
          knowledgeForChat,
          existingTestcases,
          mentionedJiraKeys,
          projectTestcaseRange,
          suites: projectSnapshot.suites,
          conversation: this.zyraTranscript(chronologicalHistory),
          routedSuite: this.routedZyraSuite(raw, projectSnapshot.suites),
          routedCount: { requestedCount: raw.requestedCount, exhaustive: raw.exhaustive === true },
          mentionedJira,
          capabilities
        });
      }
      return this.normalizeZyraChatDecision(raw, message, existingTestcases, modelIntent);
    } catch (err) {
      const errorDetail = this.extractAiErrorMessage(err);
      if (this.isZyraTimeoutError(err)) {
        // Nothing was resolved yet — routing itself never answered — so there is nothing to skip on
        // resume; continueZyraChatMessage just retries buildZyraChatDecision from this same message.
        recordGeneration(trace, { name: "router", provider, model, input: { message }, errorMessage: "timeout" });
        endZyraTurn(trace, { reply: "timeout", actionType: "timeout" });
        await this.logProjectActivity(projectId, userId, "zyra_chat_timeout", "zyra_chat", sessionId, "Zyra chat", { stage: "routing", timeoutMs: LegacyService.ZYRA_ROUTER_TIMEOUT_MS });
        return this.zyraTimedOutDecision("router", message, userMessageId, existingTestcases.length);
      }
      recordGeneration(trace, { name: "router", provider, model, input: { message }, errorMessage: errorDetail });
      endZyraTurn(trace, { reply: errorDetail, actionType: "error" });
      await this.logProjectActivity(projectId, userId, "zyra_chat_ai_failed", "zyra_chat", sessionId, "Zyra chat", { message: errorDetail, stage: "routing" });
      return this.zyraDegradedDecision(message, existingTestcases, errorDetail);
    }
  }

  /*
   * Authors the drafts for a routed 'create' turn, and is the single place that decides what happens
   * when that call fails — shared by the live chat turn (buildZyraChatDecision) and by
   * continueZyraChatMessage's resume-from-generate path, so "timed out the first time" and "timed out
   * again on resume" go through identical handling rather than two hand-maintained copies.
   *
   * A genuine error (truncated JSON, no usable drafts) still gets the existing one-retry-at-a-smaller-
   * batch treatment. A TIMEOUT does not: retrying immediately inside the same request would make the
   * user sit through a second multi-minute wait with no more feedback than the first, which is the
   * exact complaint this exists to fix. A timeout instead returns immediately with a resumable
   * checkpoint — the user decides when to wait again, via Continue.
   */
  private async zyraHandleChatCreate(params: {
    projectId: string;
    userId: string;
    sessionId: string;
    provider: string;
    model: string;
    key: Body;
    message: string;
    userMessageId?: string;
    knowledgeForChat: Array<{ title: string; content: string }>;
    existingTestcases: ZyraGenerationInput["existingTestcases"];
    mentionedJiraKeys: string[];
    projectTestcaseRange: string;
    suites: Array<{ id: string; name: string }>;
    conversation: string;
    routedSuite: { id?: string; name?: string } | null;
    routedCount: { requestedCount?: unknown; exhaustive?: boolean };
    mentionedJira: Array<{ key: string; summary: string; description: string }>;
    capabilities: ZyraCapabilities;
  }): Promise<ZyraChatDecision> {
    const {
      projectId, userId, sessionId, provider, model, key, message, userMessageId,
      knowledgeForChat, existingTestcases, mentionedJiraKeys, projectTestcaseRange, suites,
      conversation, routedSuite, routedCount, mentionedJira, capabilities
    } = params;
    try {
      const decision = await this.generateZyraChatCreateDecision({
        projectId, userId, sessionId, provider, model, key, message,
        knowledge: knowledgeForChat, existingTestcases, jiraIssueKeys: mentionedJiraKeys,
        projectTestcaseRange, suites, conversation, routedSuite, routedCount,
        // Already resolved for this turn — reuse instead of a second lookup.
        jira: mentionedJira
      });
      return this.applyStorageGateToGenerated(decision, capabilities);
    } catch (err) {
      if (this.isZyraTimeoutError(err)) {
        await this.logProjectActivity(projectId, userId, "zyra_chat_timeout", "zyra_chat", sessionId, "Zyra chat", { stage: "generation", timeoutMs: LegacyService.ZYRA_GENERATE_TIMEOUT_MS });
        return this.zyraTimedOutDecision("generate", message, userMessageId, existingTestcases.length, { routedSuite, routedCount });
      }
      // Generation is a second call and can fail on its own (truncated JSON, no usable drafts)
      // after the router already succeeded.
      const detail = this.extractAiErrorMessage(err);
      // The failed attempt's provider response, if one arrived, was still billed — see
      // generateZyraWithOpenAi/Anthropic's zyraUsage on the thrown error.
      const failedUsage = (err as { zyraUsage?: { input?: number; output?: number; total?: number } } | null)?.zyraUsage;
      if (failedUsage) await this.recordZyraTokenUsage(projectId, "chat_generate", provider, model, failedUsage);
      await this.logProjectActivity(projectId, userId, "zyra_chat_ai_failed", "zyra_chat", sessionId, "Zyra chat", { message: detail, stage: "generation" });

      const attempt = LegacyService.zyraAttemptSummary({
        requestedCount: Number(routedCount?.requestedCount) || null,
        knowledgeCount: knowledgeForChat.length,
        jiraCount: mentionedJira.length,
        suiteName: routedSuite?.name ?? null
      });

      /*
       * One retry, with a deliberately different approach rather than the same call again.
       *
       * The failure this path sees most is a response that arrived truncated — which is a
       * function of how much was asked for, so repeating the identical request is the one thing
       * guaranteed not to help. The retry asks for a small batch instead, and the reply says the
       * first attempt failed and that this is a narrowed second attempt: a user who asked for 20
       * and receives 5 is owed the reason, and finding out from the count alone is not that.
       */
      try {
        const retried = await this.generateZyraChatCreateDecision({
          projectId, userId, sessionId, provider, model, key, message,
          knowledge: knowledgeForChat, existingTestcases, jiraIssueKeys: mentionedJiraKeys,
          projectTestcaseRange, suites, conversation,
          routedSuite,
          routedCount: { requestedCount: LegacyService.ZYRA_RETRY_BATCH, exhaustive: false },
          jira: mentionedJira
        });
        const gated = this.applyStorageGateToGenerated(retried, capabilities);
        const { cause } = LegacyService.zyraFailureCause(detail);
        await this.logProjectActivity(projectId, userId, "zyra_chat_ai_retried", "zyra_chat", sessionId, "Zyra chat", {
          message: detail,
          stage: "generation_retry",
          batch: LegacyService.ZYRA_RETRY_BATCH
        });
        return {
          ...gated,
          reply: [
            `⚠️ My first attempt to ${attempt} didn't work — ${cause}.`,
            `I changed approach and tried again with a smaller batch of ${LegacyService.ZYRA_RETRY_BATCH}. That went through:`,
            "",
            gated.reply,
            "",
            "Ask me to continue and I'll add the rest in batches this size."
          ].join("\n"),
          reasoningSummary: `First generation attempt failed (${detail}); retried with a ${LegacyService.ZYRA_RETRY_BATCH}-case batch. ${gated.reasoningSummary}`
        };
      } catch (retryErr) {
        if (this.isZyraTimeoutError(retryErr)) {
          await this.logProjectActivity(projectId, userId, "zyra_chat_timeout", "zyra_chat", sessionId, "Zyra chat", { stage: "generation_retry", timeoutMs: LegacyService.ZYRA_GENERATE_TIMEOUT_MS });
          return this.zyraTimedOutDecision("generate", message, userMessageId, existingTestcases.length, {
            routedSuite,
            routedCount: { requestedCount: LegacyService.ZYRA_RETRY_BATCH, exhaustive: false }
          });
        }
        const retryDetail = this.extractAiErrorMessage(retryErr);
        const retryFailedUsage = (retryErr as { zyraUsage?: { input?: number; output?: number; total?: number } } | null)?.zyraUsage;
        if (retryFailedUsage) await this.recordZyraTokenUsage(projectId, "chat_generate", provider, model, retryFailedUsage);
        await this.logProjectActivity(projectId, userId, "zyra_chat_ai_failed", "zyra_chat", sessionId, "Zyra chat", {
          message: retryDetail,
          stage: "generation_retry"
        });
        /*
         * The router's own reply is NOT reused here any more.
         *
         * Basecamp 10231923903: this used to read `⚠️ I couldn't produce the test cases … nothing
         * was saved.\n\n${answer.reply}`. On a create turn the router has already written its reply
         * as though generation would follow — "Created 7 test cases covering passwordless biometric
         * login…" — so the user was shown a failure and a success, in that order, about the same
         * request. The 2026-07-31 "degrade to the router's answer" behaviour was right for a
         * ROUTING failure, where the answer is all there is; after a create routing the answer is
         * prose about work that did not happen.
         *
         * Basecamp 10231965612: the wording is the user's now, not the parser's. `detail` ("AI
         * testcase generation returned invalid JSON") stays in reasoningSummary and the activity
         * log, where whoever is debugging it will look — it is not something to put in front of
         * someone who asked for test cases.
         */
        return {
          reply: LegacyService.zyraFailureReply(attempt, retryDetail || detail, true),
          reasoningSummary: `Generation failed after routing (${detail}); the narrowed retry also failed (${retryDetail}). ${this.defaultReasoningSummary(existingTestcases.length)}`,
          actionType: "answer",
          operations: [],
          testcases: []
        };
      }
    }
  }

  /*
   * The reply for a provider call that genuinely never answered (see ZYRA_ROUTER_TIMEOUT_MS /
   * ZYRA_GENERATE_TIMEOUT_MS) — sendZyraChatMessage persists this as status 'timed_out' with the
   * checkpoint attached, rather than 'completed'. It is deliberately NOT phrased as a failure: nothing
   * is known to be wrong, the call just didn't finish in time, and the reply says exactly that plus
   * what happens next.
   */
  private zyraTimedOutDecision(
    stage: ZyraResumeCheckpoint["stage"],
    message: string,
    userMessageId: string | undefined,
    existingCount: number,
    resumeState?: { routedSuite: { id?: string; name?: string } | null; routedCount: { requestedCount?: unknown; exhaustive?: boolean } }
  ): ZyraChatDecision {
    return {
      reply: [
        "⏱️ I didn't hear back from the AI provider in time — nothing was created or changed, and nothing was lost.",
        "Click **Continue** below and I'll pick up right where this left off, rather than starting over."
      ].join(" "),
      reasoningSummary: `Provider call timed out at stage '${stage}' after ${stage === "router" ? LegacyService.ZYRA_ROUTER_TIMEOUT_MS : LegacyService.ZYRA_GENERATE_TIMEOUT_MS}ms. ${this.defaultReasoningSummary(existingCount)}`,
      actionType: "answer",
      operations: [],
      testcases: [],
      timedOut: true,
      resumeCheckpoint: {
        stage,
        userMessageId: userMessageId || "",
        message,
        routedSuite: resumeState?.routedSuite ?? null,
        routedCount: resumeState?.routedCount
      }
    };
  }

  private async applyZyraChatOperations(projectId: string, userId: string | null, sessionId: string, operations: ZyraChatDecision["operations"]) {
    const testcases: Body[] = [];
    const activity: Body[] = [];
    // create/update/archive no longer write straight to `testcases` — they're staged here and only
    // committed by an explicit zyraSave, same mechanism the Task board already uses. Populated below,
    // then flushed into one ai_generation_requests row (chat_session_id-linked) at the end of this
    // method if non-empty.
    const proposals: Body[] = [];
    // No originating human request in scope on some paths (e.g. a resumed background plan) —
    // attribute the mutation to Zyra's own agent actor id in that case instead of leaving it null.
    const actorId = await this.resolveZyraActor(userId);
    // Final hard gate: never persist an operation whose capability is disabled, regardless of what the model emitted.
    const capabilities = await this.zyraProjectCapabilities(projectId);
    const allowed = operations.filter((op) => {
      if (op.type === "create" || op.type === "update" || op.type === "archive") return capabilities.testcaseStorage;
      if (op.type === "create_suite" || op.type === "move_to_suite") return capabilities.suiteOperations;
      return false;
    });
    // Ids created earlier in THIS batch — merged into fromLastPlan resolution below so a single
    // turn that both creates testcases and moves them (fromLastPlan:true) works in one shot,
    // instead of only seeing last_completed_plan from a prior turn (see resolveZyraMoveTargets).
    // Always empty now: a "create" op is staged, not written, so there is no real id yet to move.
    // A create op that also needs a specific suite should (and already can) set its own
    // suiteId/suiteName directly rather than relying on a same-turn move_to_suite.
    const createdThisTurn: string[] = [];
    // Per-suite move bookkeeping for the reply's ground-truth breakdown (see reconcileZyraReply /
    // zyraMoveBreakdownSuffix). Deliberately NOT a running count incremented as each move_to_suite op
    // executes: if the model puts the same testcase id in two different suites in one turn (a real
    // classification mistake), an incremented count would double-count it across both suites even
    // though the row can only end up in one. moveTargetIds collects every id any move op touched this
    // turn; moveSuites records which suites were targeted (and whether this turn created them); the
    // actual per-suite counts are read back from the database after the loop, once, so each id is
    // counted exactly once — under whichever suite it actually landed in.
    const moveTargetIds = new Set<string>();
    const moveSuites = new Map<string, { suiteName: string; created: boolean }>();
    // A per-turn ceiling still bounds a model that emits junk, but it used to sit at 10 — below
    // what a single legitimate generation batch produces (chatTestcasePlan allows up to 25), so
    // asking for 15 test cases saved 10 of them and said 15. Truncation is now both rarer and
    // reported, never silent.
    const dropped = allowed.length - Math.min(allowed.length, LegacyService.ZYRA_CHAT_MAX_OPERATIONS);
    if (dropped > 0) {
      activity.push({
        actor: "agent",
        title: "Skipped some operations",
        detail: `${dropped} operation(s) beyond the ${LegacyService.ZYRA_CHAT_MAX_OPERATIONS}-per-message limit were not applied.`,
        createdAt: new Date().toISOString()
      });
    }
    for (const op of allowed.slice(0, LegacyService.ZYRA_CHAT_MAX_OPERATIONS)) {
      if (op.type === "create" && op.draft) {
        // A create op may name a target suite directly (op.suiteId / op.suiteName) so a new
        // testcase can land in the right suite in the same step, mirroring how the Task-based
        // flow (zyraSave) resolves a suite before creating — chat creates used to always land
        // unassigned (suite_id NULL) because this resolution never happened.
        let suiteId: string | null = null;
        if (op.suiteId) {
          const suite = await this.getProjectSuite(projectId, op.suiteId);
          suiteId = suite ? suite.id : null;
        }
        // No suite named — or one named that no longer resolves — stages in Zyra's own suite rather
        // than landing unassigned. The case is a real, openable, runnable row either way; what
        // changes is that it is now identifiable as an unfiled agent draft.
        const suiteName = op.suiteName || (suiteId ? null : LegacyService.ZYRA_DRAFT_SUITE_NAME);
        if (!suiteId && suiteName) {
          const suite = await this.resolveOrCreateSuiteByName(projectId, suiteName);
          suiteId = suite.id;
          if (suite.created) {
            activity.push({ actor: "agent", title: "Created suite", detail: suite.name, createdAt: new Date().toISOString() });
            await this.logProjectActivity(projectId, actorId, "zyra_suite_created", "suite", suite.id, suite.name, { source: "zyra_chat", reason: op.reason || null });
          }
        }
        const draftPayload = {
          suiteId,
          title: op.draft.title,
          description: op.draft.description || op.draft.expectedSummary || "",
          preconditions: op.draft.preconditions || "",
          stepsJson: this.safeSteps(op.draft.stepsJson || op.draft.steps),
          testData: op.draft.testData || "",
          priority: op.draft.priority || "P2",
          severity: op.draft.severity || null,
          type: op.draft.type || "Functional",
          status: op.draft.status || "Draft",
          component: op.draft.component || null,
          jiraIssueKey: op.draft.jiraIssueKey || null
        };
        // Staged only — no insert, no external-id allocation, nothing to collide on yet. The
        // draft is committed (and a real external id allocated) only by zyraSave, which is also
        // where a 23505 collision can occur and is retried at the batch level.
        proposals.push({ opType: "create", draft: draftPayload, reason: op.reason || "" });
        testcases.push({
          ...this.chatDraftRow(draftPayload, "proposed-create", op.reason),
          draftIndex: proposals.length - 1
        });
        activity.push({ actor: "agent", title: "Drafted testcase for review", detail: draftPayload.title || "Untitled test case", createdAt: new Date().toISOString() });
      } else if ((op.type === "update" || op.type === "archive") && (op.testcaseId || op.externalId)) {
        const found = await this.findProjectTestcase(projectId, op.testcaseId, op.externalId);
        if (!found) continue;
        const fields = op.type === "archive" ? { status: "Archived" } : this.sanitizeZyraUpdateFields(op.fields || {});
        const row = await this.getTestCase(found.id);
        // Staged only — the real row is untouched until zyraSave applies `fields` to it.
        proposals.push({ opType: op.type, testcaseId: found.id, externalId: row.externalId, fields, reason: op.reason || "" });
        const action = op.type === "archive" ? "proposed-archive" : "proposed-update";
        // The review row previews what the case will look like AFTER saving (row + fields merged),
        // not its current state — `row` alone would show what's about to change as if it already had.
        const preview = { ...row, ...(fields.stepsJson !== undefined ? { steps: fields.stepsJson } : {}), ...fields };
        testcases.push({ ...this.chatTestcaseRow(preview, action, op.reason), draftIndex: proposals.length - 1 });
        activity.push({ actor: "agent", title: `Drafted ${op.type} for review`, detail: `${row.externalId} ${row.title}`, createdAt: new Date().toISOString() });
      } else if (op.type === "create_suite" && op.suiteName) {
        const suite = await this.resolveOrCreateSuiteByName(projectId, op.suiteName);
        activity.push({ actor: "agent", title: suite.created ? "Created suite" : "Suite already exists", detail: suite.name, createdAt: new Date().toISOString() });
        if (suite.created) {
          await this.logProjectActivity(projectId, actorId, "zyra_suite_created", "suite", suite.id, suite.name, { source: "zyra_chat", reason: op.reason || null });
        }
      } else if (op.type === "move_to_suite" && (op.suiteName || op.suiteId)) {
        const suite = op.suiteId
          ? await this.getProjectSuite(projectId, op.suiteId)
          : await this.resolveOrCreateSuiteByName(projectId, String(op.suiteName));
        if (!suite) continue;
        // Recorded even when nothing matches below, so a suite the model claimed to move cases into
        // still shows up in the breakdown as 0 rather than silently disappearing from it.
        const existingMoveSuite = moveSuites.get(suite.id);
        moveSuites.set(suite.id, {
          suiteName: suite.name,
          created: existingMoveSuite?.created || ("created" in suite && !!suite.created)
        });
        const targets = await this.resolveZyraMoveTargets(projectId, sessionId, op, suite.id, createdThisTurn);
        if (!targets.length) {
          // resolveOrCreateSuiteByName above may have just created the suite, so bailing silently
          // here left a new empty suite behind with no activity entry and no signal that the move
          // matched nothing — while the model's reply still announced a successful save.
          activity.push({
            actor: "agent",
            title: "No testcases matched",
            detail: `Nothing was moved into "${suite.name}" — the requested testcases do not exist in this project yet.`,
            createdAt: new Date().toISOString()
          });
          continue;
        }
        const movedIds = targets.map((target) => target.id);
        for (const id of movedIds) moveTargetIds.add(id);
        await this.db.query(
          "UPDATE testcases SET suite_id = $2, updated_by = $4, updated_at = now() WHERE project_id = $1 AND id = ANY($3::uuid[]) AND deleted_at IS NULL",
          [projectId, suite.id, movedIds, actorId]
        );
        for (const target of targets.slice(0, 25)) {
          const row = await this.getTestCase(target.id);
          testcases.push(this.chatTestcaseRow(row, "moved", op.reason || `Moved to suite ${suite.name}`));
        }
        activity.push({ actor: "agent", title: `Moved ${movedIds.length} testcase(s) to suite`, detail: `${suite.name}${"created" in suite && suite.created ? " (created)" : ""}`, createdAt: new Date().toISOString() });
        await this.logProjectActivity(projectId, actorId, "zyra_moved_to_suite", "suite", suite.id, suite.name, { source: "zyra_chat", movedCount: movedIds.length, testcaseIds: movedIds, reason: op.reason || null });
      }
    }
    let reviewRequestId: string | null = null;
    if (proposals.length) {
      const inserted = await this.db.query(
        `INSERT INTO ai_generation_requests
         (project_id, requested_by, provider, model, user_story, requested_count, generated_count,
          generated_payload, agent_name, task_status, chat_session_id)
         VALUES ($1,$2,'zyra_chat',NULL,$3,$4,$4,$5::jsonb,$6,'in_review',$7)
         RETURNING id`,
        [projectId, actorId, `Zyra chat proposal (session ${sessionId})`, proposals.length, JSON.stringify(proposals), ZYRA_AGENT_NAME, sessionId]
      );
      reviewRequestId = String(inserted.rows[0].id);
      // draftIndex on each row addresses generated_payload by position — set once the request
      // (and therefore its final id) exists, since it can't be known beforehand.
      for (const tc of testcases) {
        if (typeof tc.draftIndex === "number") tc.reviewRequestId = reviewRequestId;
      }
    }
    const moveBreakdown = await this.zyraMoveBreakdown(projectId, moveSuites, moveTargetIds);
    return { testcases, activity, reviewRequestId, moveBreakdown };
  }

  // Ground truth for how many testcases actually ended up in each suite a move_to_suite operation
  // targeted this turn — read back from the database after every operation has run, rather than
  // trusting the model's own count of what it moved. See applyZyraChatOperations for why this is a
  // single read-back query instead of an incremented counter (same-turn overlap correctness).
  private async zyraMoveBreakdown(
    projectId: string,
    moveSuites: Map<string, { suiteName: string; created: boolean }>,
    moveTargetIds: Set<string>
  ): Promise<Array<{ suiteId: string; suiteName: string; created: boolean; count: number }>> {
    if (!moveSuites.size) return [];
    const counts = new Map<string, number>();
    if (moveTargetIds.size) {
      const res = await this.db.query(
        `SELECT suite_id, count(*)::int AS count FROM testcases
         WHERE project_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL
         GROUP BY suite_id`,
        [projectId, Array.from(moveTargetIds)]
      ).catch(() => ({ rows: [] as Body[] }));
      for (const row of res.rows) counts.set(String(row.suite_id), Number(row.count) || 0);
    }
    return Array.from(moveSuites.entries()).map(([suiteId, info]) => ({
      suiteId,
      suiteName: info.suiteName,
      created: info.created,
      count: counts.get(suiteId) || 0
    }));
  }

  private async resolveOrCreateSuiteByName(projectId: string, name: string): Promise<{ id: string; name: string; created: boolean }> {
    const trimmed = String(name || "").trim();
    const existing = await this.db.query(
      "SELECT id, name FROM suites WHERE project_id = $1 AND lower(name) = lower($2) ORDER BY position, created_at LIMIT 1",
      [projectId, trimmed]
    ).catch(() => ({ rows: [] as Body[] }));
    if (existing.rows[0]) return { id: String(existing.rows[0].id), name: String(existing.rows[0].name), created: false };
    const created = await this.createSuite(projectId, { name: trimmed }) as Body;
    return { id: String(created.id), name: String(created.name), created: true };
  }

  private async getProjectSuite(projectId: string, suiteId: string): Promise<{ id: string; name: string } | null> {
    const res = await this.db.query(
      "SELECT id, name FROM suites WHERE project_id = $1 AND id = $2::uuid LIMIT 1",
      [projectId, suiteId]
    ).catch(() => ({ rows: [] as Body[] }));
    return res.rows[0] ? { id: String(res.rows[0].id), name: String(res.rows[0].name) } : null;
  }

  // Resolve which existing testcases a move_to_suite op should affect: every non-archived testcase
  // (allExisting), the ones named by external id / internal id, or — when the model set
  // fromLastPlan (see the move_to_suite prompt instructions) — every testcase tracked in
  // last_completed_plan, unioned with any ids created earlier in the SAME batch. That union
  // matters because last_completed_plan is only persisted after the whole batch finishes
  // (see sendZyraChatMessage), so a single turn that both creates testcases and moves them
  // (fromLastPlan:true) would otherwise see only the previous turn's batch, or none at all.
  // last_completed_plan tracking exists because the model's own view of "which testcases did
  // we just generate" is limited to the last 12 chat messages, which a multi-batch plan can
  // easily outgrow; it's a durable, exact record instead of something the model has to
  // re-enumerate from a possibly-truncated history. Never creates testcases.
  private async resolveZyraMoveTargets(projectId: string, sessionId: string, op: ZyraChatDecision["operations"][number], targetSuiteId: string, createdThisTurn: string[] = []): Promise<Array<{ id: string }>> {
    if (op.allExisting) {
      const res = await this.db.query(
        "SELECT id FROM testcases WHERE project_id = $1 AND COALESCE(status,'') <> 'Archived' AND suite_id IS DISTINCT FROM $2::uuid AND deleted_at IS NULL",
        [projectId, targetSuiteId]
      ).catch(() => ({ rows: [] as Body[] }));
      return res.rows.map((row) => ({ id: String(row.id) }));
    }
    if (op.fromLastPlan) {
      const planRes = await this.db.query("SELECT last_completed_plan FROM zyra_chat_sessions WHERE id = $1", [sessionId]).catch(() => ({ rows: [] as Body[] }));
      const priorIds = normalizeJsonArray((planRes.rows[0]?.last_completed_plan as Body | undefined)?.testcaseIds).map(String);
      const ids = Array.from(new Set([...createdThisTurn, ...priorIds]));
      if (!ids.length) return [];
      const res = await this.db.query(
        "SELECT id FROM testcases WHERE project_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL",
        [projectId, ids]
      ).catch(() => ({ rows: [] as Body[] }));
      return res.rows.map((row) => ({ id: String(row.id) }));
    }
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const externalIds = [...(op.externalIds || []), ...(op.externalId ? [op.externalId] : [])].map((value) => String(value).trim()).filter(Boolean);
    const internalIds = [...(op.testcaseIds || []), ...(op.testcaseId ? [op.testcaseId] : [])].map((value) => String(value).trim()).filter((value) => uuidPattern.test(value));
    if (!externalIds.length && !internalIds.length) return [];
    const res = await this.db.query(
      "SELECT id FROM testcases WHERE project_id = $1 AND (external_id = ANY($2::text[]) OR id = ANY($3::uuid[])) AND deleted_at IS NULL",
      [projectId, externalIds, internalIds]
    ).catch(() => ({ rows: [] as Body[] }));
    return res.rows.map((row) => ({ id: String(row.id) }));
  }

  private async generateZyraChatTestcasesWithAi(params: {
    projectId: string;
    userId: string | null;
    provider: string;
    model: string;
    key: Body;
    message: string;
    knowledge: Array<{ title: string; content: string }>;
    existingTestcases: ZyraGenerationInput["existingTestcases"];
    jiraIssueKeys: string[];
    requestedCount: number;
    testcaseRange?: string;
    suites: Array<{ id: string; name: string }>;
    conversation?: string;
    routedSuite?: { id?: string; name?: string } | null;
    jira?: Array<{ key: string; summary: string; description: string }>;
  }): Promise<ZyraChatDecision> {
    // Prefer the Jira context already gathered for this turn (explicit keys plus relevance-matched
    // tickets); fall back to an explicit-key lookup only when a caller supplied none.
    const jira = params.jira ?? await this.relevantJiraSnapshot(params.projectId, params.message, params.jiraIssueKeys);
    // The router resolved the suite from the whole conversation ("put them in Login", "same suite
    // as before"); substring-matching the raw message is only the fallback for when it named none.
    const matchedSuite = this.resolveRoutedZyraSuite(params.routedSuite, params.suites)
      || this.matchZyraSuiteByName(params.message, params.suites);
    const jiraFromKnowledge = this.countZyraJiraSourcedKnowledge(params.knowledge);
    const aiResult = await this.generateZyraWithProvider({
      provider: params.provider,
      model: params.model,
      apiKey: params.key.api_key,
      baseUrl: params.key.base_url,
      authHeaderName: params.key.auth_header_name,
      authScheme: params.key.auth_scheme,
      projectId: params.projectId,
      input: {
        story: params.message,
        context: [
          "Generated from Zyra chat after reading project knowledge, Jira ticket details, Zyra memory, and existing testcase coverage.",
          // The generator never sees the chat itself, so a confirmation ("yes, do it", "save
          // those") would otherwise arrive as a story with no content. The conversation is passed
          // whole and the model decides whether the request refers back to it.
          params.conversation
            ? `Conversation so far. If the user's request is a confirmation of, or a reference to, test cases already described in this conversation, generate exactly those — same titles, same order, same coverage — filling in complete steps and expected results. Otherwise treat this only as background:\n${params.conversation}`
            : ""
        ].filter(Boolean).join("\n\n"),
        acceptanceCriteria: "",
        feedback: "",
        knowledge: params.knowledge,
        jira,
        linear: [],
        existingTestcases: params.existingTestcases,
        requestedCount: params.requestedCount,
        testcaseRange: params.testcaseRange
      }
    });
    // This one function backs every chat-driven "create" call: the first turn, the first batch of
    // an exhaustive plan (startZyraChatPlan), and every subsequent background batch
    // (continueZyraChatPlan's loop) — instrumenting it once covers all three.
    await this.recordZyraTokenUsage(params.projectId, "chat_generate", params.provider, params.model, aiResult.usage);
    await this.rememberZyraTurn({
      projectId: params.projectId,
      userId: params.userId,
      provider: params.provider,
      model: params.model,
      key: params.key,
      userMessage: params.message,
      outcome: [
        `Generated ${aiResult.drafts.length} testcase draft(s).`,
        params.jiraIssueKeys.length ? `Jira keys: ${params.jiraIssueKeys.join(", ")}` : "",
        `Sources considered: ${params.knowledge.length} knowledge-base item(s), ${jira.length} Jira ticket(s), ${params.existingTestcases.length} existing testcase(s).`
      ].filter(Boolean).join(" ")
    });
    // Nothing in the knowledge base and no Jira ticket matched: these drafts are the model's general
    // knowledge, not this team's requirements, and the reply has to lead with that.
    const ungrounded = params.knowledge.length === 0 && jira.length === 0;
    const stagedSuiteName = matchedSuite?.name ?? LegacyService.ZYRA_DRAFT_SUITE_NAME;
    const groundedReply = [
        `I drafted ${aiResult.drafts.length} test case(s) after reading`,
        [
          `${params.knowledge.length} knowledge-base item(s)${jiraFromKnowledge ? ` (${jiraFromKnowledge} mirrored from Jira)` : ""}`,
          `${jira.length} Jira ticket(s) read directly`,
          `${params.existingTestcases.length} existing test case(s) to avoid duplicating coverage`
        ].join(", "),
        "."
    ].join(" ").replace(" .", ".") + `\n\n${LegacyService.zyraDraftFilingHint(stagedSuiteName)}`;
    return {
      reply: ungrounded
        ? [LegacyService.zyraUngroundedNote(aiResult.drafts.length), LegacyService.zyraDraftFilingHint(stagedSuiteName)].join("\n\n")
        : groundedReply,
      reasoningSummary: `AI generation used ${params.provider}/${params.model}. It considered Jira keys ${params.jiraIssueKeys.length ? params.jiraIssueKeys.join(", ") : "none explicitly mentioned"}, knowledge-base context, existing coverage for duplicate avoidance, and Zyra memory. Tokens: input ${aiResult.usage.input}, output ${aiResult.usage.output}.`,
      actionType: "create",
      operations: aiResult.drafts.map((draft) => ({
        type: "create",
        // A suite the router named but that does not exist yet carries only a name — it is created
        // on demand when the operation is applied (resolveOrCreateSuiteByName).
        suiteId: matchedSuite?.id,
        suiteName: matchedSuite?.id ? undefined : matchedSuite?.name,
        draft: {
          ...draft,
          jiraIssueKey: params.jiraIssueKeys[0] || draft.jiraIssueKey || null
        },
        reason: "Generated by AI from Zyra chat context."
      })),
      testcases: aiResult.drafts.map((draft) => this.chatDraftRow(draft, "suggested", "Generated by AI from Zyra chat context."))
    };
  }

  // The context Zyra reads before authoring anything: knowledge base by folder name and by semantic
  // (RAG) retrieval, with a recency snapshot as the floor, plus the existing testcases so coverage
  // that already exists is not written twice. Shared by the interactive turn and by every
  // background batch — batches 2..N used to gather a plain recency snapshot with no RAG and no
  // capability gate, so a long generation silently drifted away from the sources batch 1 used.
  private async zyraGenerationContext(
    projectId: string,
    message: string,
    jiraIssueKeys: string[],
    capabilities: ZyraCapabilities
  ): Promise<{
    knowledge: Array<{ title: string; content: string }>;
    existingTestcases: ZyraGenerationInput["existingTestcases"];
    suites: Array<{ id: string; name: string; testCaseCount: number }>;
    jira: Array<{ key: string; summary: string; description: string }>;
  }> {
    const [knowledgeFallback, ragKnowledge, folderKnowledge, existingTestcases, suites, jira] = await Promise.all([
      this.knowledgeSnapshot(projectId),
      this.ragRetrieval.retrieveKnowledgeContext(projectId, message),
      this.knowledgeFolderSnapshot(projectId, message, jiraIssueKeys),
      this.existingTestcaseSnapshot(projectId, message, ""),
      this.projectSuiteSummaries(projectId),
      // Relevance-matched, not just explicitly-named — see relevantJiraSnapshot.
      this.relevantJiraSnapshot(projectId, message, jiraIssueKeys)
    ]);
    const knowledge = [...folderKnowledge, ...(ragKnowledge.length ? ragKnowledge : knowledgeFallback)];
    return {
      knowledge: capabilities.knowledgeBase ? knowledge : [],
      existingTestcases,
      suites,
      jira
    };
  }

  private static readonly ZYRA_PLAN_BATCH_SIZE = 5;
  private static readonly ZYRA_PLAN_MAX_SCENARIOS = 40;
  // Matches the largest batch chatTestcasePlan will ask for, so a legitimate generation is never
  // partially applied (see applyZyraChatOperations / normalizeZyraChatDecision).
  private static readonly ZYRA_CHAT_MAX_OPERATIONS = 25;
  /*
   * The knowledge document Zyra keeps its project memory in.
   *
   * It is a real knowledge_documents row on purpose — it is pinned into RAG context and readable, so
   * a team can see what Zyra has learned. What it is NOT is a user document: deleting or renaming it
   * throws away everything Zyra remembers about the project, and a rename also detaches it, since
   * rememberZyraMemory and zyraMemoryText both find it BY TITLE and would silently start a second,
   * empty memory. Basecamp 10212786541.
   */
  private static readonly ZYRA_MEMORY_DOC_TITLE = "Zyra AI Memory";

  private zyraBatchMessage(originalMessage: string, batch: string[]): string {
    return [
      originalMessage,
      "",
      "Generate exactly one distinct testcase for each of these scenarios (do not add extras, do not skip any):",
      ...batch.map((scenario, index) => `${index + 1}. ${scenario}`)
    ].join("\n");
  }

  // "All possible cases" no longer asks the model for everything in one shot (that instruction
  // was truncating past the provider's output token ceiling and returning invalid JSON). Instead
  // Zyra first plans a todo list of distinct scenarios, generates the first small batch inline,
  // and hands the rest to a fire-and-forget loop that posts each remaining batch as its own chat
  // message — mirroring a todo-list-then-execute-one-by-one workflow.
  private async startZyraChatPlan(params: {
    projectId: string;
    userId: string;
    sessionId: string;
    provider: string;
    model: string;
    key: Body;
    message: string;
    knowledge: Array<{ title: string; content: string }>;
    existingTestcases: ZyraGenerationInput["existingTestcases"];
    jiraIssueKeys: string[];
    suites: Array<{ id: string; name: string }>;
    conversation?: string;
    routedSuite?: { id?: string; name?: string } | null;
    jira?: Array<{ key: string; summary: string; description: string }>;
  }): Promise<ZyraChatDecision> {
    let scenarios: string[] = [];
    try {
      scenarios = await this.planZyraChatScenarios({
        projectId: params.projectId,
        provider: params.provider,
        model: params.model,
        key: params.key,
        message: params.message,
        knowledge: params.knowledge,
        existingTestcases: params.existingTestcases,
        maxScenarios: LegacyService.ZYRA_PLAN_MAX_SCENARIOS
      });
    } catch {
      scenarios = [];
    }

    if (scenarios.length < 2) {
      // Planning failed or found too little to plan around — fall back to one bounded batch
      // rather than risk the same truncation the "generate as many as possible" prompt caused.
      return this.generateZyraChatTestcasesWithAi({
        projectId: params.projectId,
        userId: params.userId,
        provider: params.provider,
        model: params.model,
        key: params.key,
        message: params.message,
        knowledge: params.knowledge,
        existingTestcases: params.existingTestcases,
        jiraIssueKeys: params.jiraIssueKeys,
        requestedCount: 10,
        suites: params.suites,
        conversation: params.conversation,
        routedSuite: params.routedSuite,
        jira: params.jira
      });
    }

    const firstBatch = scenarios.slice(0, LegacyService.ZYRA_PLAN_BATCH_SIZE);
    const remaining = scenarios.slice(LegacyService.ZYRA_PLAN_BATCH_SIZE);
    const decision = await this.generateZyraChatTestcasesWithAi({
      projectId: params.projectId,
      userId: params.userId,
      provider: params.provider,
      model: params.model,
      key: params.key,
      message: this.zyraBatchMessage(params.message, firstBatch),
      knowledge: params.knowledge,
      existingTestcases: params.existingTestcases,
      jiraIssueKeys: params.jiraIssueKeys,
      requestedCount: firstBatch.length,
      suites: params.suites,
      conversation: params.conversation,
      routedSuite: params.routedSuite,
      jira: params.jira
    });

    if (!remaining.length) return decision;

    const planId = randomUUID();
    await this.db.query(
      "UPDATE zyra_chat_sessions SET active_plan = $2::jsonb, updated_at = now() WHERE id = $1",
      [params.sessionId, JSON.stringify({
        planId,
        status: "running",
        originalMessage: params.message,
        jiraIssueKeys: params.jiraIssueKeys,
        routedSuite: params.routedSuite || null,
        remainingScenarios: remaining,
        batchSize: LegacyService.ZYRA_PLAN_BATCH_SIZE,
        doneCount: firstBatch.length,
        totalCount: scenarios.length
      })]
    );
    void this.continueZyraChatPlan(params.projectId, params.userId, params.sessionId, planId).catch(() => undefined);

    return {
      ...decision,
      reply: `I identified ${scenarios.length} distinct scenarios to cover. Here are the first ${firstBatch.length} — I'll keep generating the rest (${remaining.length} more) and post them here as they're ready; feel free to review these in the meantime.\n\n${decision.reply}`
    };
  }

  private async postZyraPlanMessage(projectId: string, sessionId: string, userId: string | null, reply: string, testcases: Body[], activity: Body[]): Promise<void> {
    await this.db.query(
      `INSERT INTO zyra_chat_messages
       (session_id, project_id, user_id, role, content, reasoning_summary, action_type, status, testcases, activity)
       VALUES ($1,$2,$3,'assistant',$4,$5,'create','completed',$6::jsonb,$7::jsonb)`,
      [sessionId, projectId, userId, reply, "Continuing a batched 'all possible cases' generation plan.", JSON.stringify(testcases), JSON.stringify(activity)]
    );
    await this.db.query("UPDATE zyra_chat_sessions SET updated_at = now() WHERE id = $1", [sessionId]);
  }

  private async clearZyraChatPlan(sessionId: string): Promise<void> {
    await this.db.query("UPDATE zyra_chat_sessions SET active_plan = NULL WHERE id = $1", [sessionId]);
  }

  // Fire-and-forget continuation (mirrors processZyraTask's pattern): re-checks the plan id
  // before every batch so a new user message — which clears active_plan in sendZyraChatMessage —
  // stops this loop cleanly instead of racing further messages into the session.
  private async continueZyraChatPlan(projectId: string, userId: string | null, sessionId: string, planId: string): Promise<void> {
    for (;;) {
      const sessionRes = await this.db.query("SELECT active_plan FROM zyra_chat_sessions WHERE id = $1 AND project_id = $2", [sessionId, projectId]);
      const plan = sessionRes.rows[0]?.active_plan as Body | undefined;
      if (!plan || plan.planId !== planId) return;

      const remainingScenarios = normalizeJsonArray(plan.remainingScenarios).map(String);
      const batchSize = Number(plan.batchSize) || LegacyService.ZYRA_PLAN_BATCH_SIZE;
      const batch = remainingScenarios.slice(0, batchSize);
      if (!batch.length) {
        await this.clearZyraChatPlan(sessionId);
        return;
      }

      const doneCount = Number(plan.doneCount || 0);
      const totalCount = Number(plan.totalCount || 0);
      // Hoisted so the catch block below can still record tokens from a billed-but-unparsed
      // response even though provider/model are only known once the allocation resolves.
      let provider = "unknown";
      let model = "unknown";
      try {
        const allocation = await this.zyraAiAllocation(projectId);
        if (!allocation.key) {
          await this.postZyraPlanMessage(projectId, sessionId, userId, `I couldn't continue generating more test cases — ${allocation.reason}`, [], []);
          await this.clearZyraChatPlan(sessionId);
          return;
        }
        const capabilities = await this.zyraProjectCapabilities(projectId);
        if (!capabilities.generation) {
          await this.postZyraPlanMessage(projectId, sessionId, userId, "Test case generation was disabled for Zyra in this project, so I stopped generating the remaining scenarios. Enable it under Zyra → Settings → Capabilities to continue.", [], []);
          await this.clearZyraChatPlan(sessionId);
          return;
        }
        provider = String(allocation.key.provider || "openai").toLowerCase();
        model = normalizeProviderModel(provider, allocation.key.default_model);
        const originalMessage = String(plan.originalMessage || "");
        const jiraIssueKeys = normalizeJsonArray(plan.jiraIssueKeys).map(String);
        // Re-read the sources for every batch: existing coverage grows as earlier batches land, so
        // this is also what stops batch N from duplicating what batch N-1 just wrote.
        const { knowledge, existingTestcases, suites, jira } = await this.zyraGenerationContext(
          projectId,
          `${originalMessage}\n${batch.join("\n")}`,
          jiraIssueKeys,
          capabilities
        );
        const decision = await this.generateZyraChatTestcasesWithAi({
          projectId,
          userId,
          provider,
          model,
          key: allocation.key,
          message: this.zyraBatchMessage(originalMessage, batch),
          knowledge,
          existingTestcases,
          jiraIssueKeys,
          jira,
          requestedCount: batch.length,
          suites,
          // Carried in the plan so every batch files into the suite the user asked for, not just
          // the first — a routed suite id is not recoverable from the original message text.
          routedSuite: (plan.routedSuite as { id?: string; name?: string } | null) || null
        });
        const gated = this.applyStorageGateToGenerated(decision, capabilities);
        const applied = await this.applyZyraChatOperations(projectId, userId, sessionId, gated.operations);
        const testcases = applied.testcases.length ? applied.testcases : gated.testcases;
        await this.recordZyraLastCompletedPlanIds(sessionId, testcases.map((tc) => tc.id).filter(Boolean));

        const newDoneCount = doneCount + batch.length;
        const remaining = remainingScenarios.slice(batch.length);
        // Never announce a batch that wrote nothing — the same false-success trap the chat path had.
        const reply = !testcases.length
          ? [
              `⚠️ This batch saved nothing — none of the ${batch.length} scenario(s) produced a stored test case.`,
              remaining.length ? `Continuing with the remaining ${remaining.length}.` : "That was the last batch."
            ].join(" ")
          : remaining.length
            ? `Here are ${testcases.length} more test case(s) — ${newDoneCount}/${totalCount} scenarios covered so far. Still working on the remaining ${remaining.length}; I'll post the next batch shortly.`
            : `Here are the final ${testcases.length} test case(s) — all ${totalCount} scenarios are now covered. Feel free to review and let me know if you'd like any changes.`;
        await this.postZyraPlanMessage(projectId, sessionId, userId, reply, testcases, applied.activity);

        if (!remaining.length) {
          await this.clearZyraChatPlan(sessionId);
          return;
        }
        // Re-check we're still the active plan before writing progress — the user may have
        // sent a new message (which clears active_plan) while this batch was generating.
        const stillActiveRes = await this.db.query("SELECT active_plan FROM zyra_chat_sessions WHERE id = $1", [sessionId]);
        const stillActive = stillActiveRes.rows[0]?.active_plan as Body | undefined;
        if (!stillActive || stillActive.planId !== planId) return;
        await this.db.query(
          "UPDATE zyra_chat_sessions SET active_plan = $2::jsonb, updated_at = now() WHERE id = $1",
          [sessionId, JSON.stringify({ ...plan, remainingScenarios: remaining, doneCount: newDoneCount })]
        );
      } catch (err) {
        const detail = this.extractAiErrorMessage(err);
        // A batch whose provider response arrived (and was billed) but failed to parse still
        // carries its usage on the thrown error — see generateZyraWithOpenAi/Anthropic.
        const batchUsage = (err as { zyraUsage?: { input?: number; output?: number; total?: number } } | null)?.zyraUsage;
        if (batchUsage) await this.recordZyraTokenUsage(projectId, "chat_generate", provider, model, batchUsage);
        // Pause rather than discard: remainingScenarios/doneCount are unchanged (this batch
        // never succeeded), so "continue" — or resumeZyraChatPlan — can retry from here later.
        await this.postZyraPlanMessage(projectId, sessionId, userId, `I ran into an issue generating more test cases (${detail}). Pausing here — ${doneCount}/${totalCount} scenarios covered. Say "continue" and I'll retry the rest.`, [], []);
        await this.db.query(
          "UPDATE zyra_chat_sessions SET active_plan = $2::jsonb WHERE id = $1",
          [sessionId, JSON.stringify({ ...plan, status: "paused" })]
        );
        return;
      }
    }
  }

  private async recordZyraLastCompletedPlanIds(sessionId: string, newIds: string[]): Promise<void> {
    if (!newIds.length) return;
    const res = await this.db.query("SELECT last_completed_plan FROM zyra_chat_sessions WHERE id = $1", [sessionId]).catch(() => ({ rows: [] as Body[] }));
    const existingIds = normalizeJsonArray((res.rows[0]?.last_completed_plan as Body | undefined)?.testcaseIds).map(String);
    const mergedIds = Array.from(new Set([...existingIds, ...newIds]));
    await this.db.query(
      "UPDATE zyra_chat_sessions SET last_completed_plan = $2::jsonb WHERE id = $1",
      [sessionId, JSON.stringify({ testcaseIds: mergedIds, totalCount: mergedIds.length })]
    );
  }

  private async finalizeZyraToolDecisionWithAi(params: {
    projectId: string;
    key: Body;
    provider: string;
    model: string;
    message: string;
    context: string;
    toolName: string;
    toolDecision: ZyraChatDecision;
  }): Promise<ZyraChatDecision> {
    const finalizePrompt = [
      params.context,
      "",
      "A backend project-data tool has completed. Use this exact tool result as factual source data.",
      "Write the final user-facing response in Zyra's expert QA voice.",
      "Do not invent numbers, tickets, or testcase rows beyond the tool result.",
      "Return ONLY a single valid JSON object — no markdown fences, no text outside the JSON:",
      "{\"reply\":\"\",\"reasoningSummary\":\"\",\"action\":\"answer\",\"actionType\":\"answer\",\"operations\":[],\"testcases\":[{}]}",
      "REPLY FIELD: human-readable markdown. Use ## headings, - bullets, **bold**, markdown tables (| H | H |\\n|---|---|\\n| v | v |). Never put raw JSON or code blocks inside reply. Be direct and structured.",
      "",
      `Tool name: ${params.toolName}`,
      `Tool result JSON: ${JSON.stringify(params.toolDecision)}`
    ].join("\n");
    const raw = providerWire(params.provider) === "anthropic"
      ? await this.zyraChatWithAnthropic(params.key, params.model, finalizePrompt, params.message)
      : await this.zyraChatWithOpenAi(params.key, params.model, finalizePrompt, params.message);
    await this.recordZyraTokenUsage(params.projectId, "chat_tool_finalize", params.provider, params.model, raw.__zyraUsage || {});
    return {
      reply: this.sanitizeZyraReply(raw.reply, String(params.toolDecision.reply || "")),
      reasoningSummary: String(raw.reasoningSummary || params.toolDecision.reasoningSummary || "").slice(0, 1500),
      actionType: "answer",
      operations: [],
      testcases: normalizeJsonArray(raw.testcases).length ? normalizeJsonArray(raw.testcases).slice(0, 50) : params.toolDecision.testcases
    };
  }

  async aiGenerate(projectId: string, userId: string | null | undefined, body: Body) {
    const uid = this.requireUser(userId);
    // Resolved before the allocation lookup: without it a malformed project id reached a uuid column
    // and answered with a 500, and any workspace member could spend another project's AI allowance.
    await this.requireProjectAccess(uid, projectId);
    const allocation = await this.db.query(
      `SELECT k.provider, k.default_model, k.api_key, k.base_url, k.auth_header_name, k.auth_scheme
       FROM project_ai_key_allocations a
       JOIN workspace_ai_keys k ON k.id = a.workspace_ai_key_id
       WHERE a.project_id = $1 AND k.is_active = true`,
      [projectId]
    );
    if (!allocation.rows[0]) throw new BadRequestException({ error: "Zyra is inactive. Allocate an OpenAI or Claude key to this project first." });
    const provider = String(body.provider || allocation.rows[0].provider || "openai").toLowerCase();
    const model = normalizeProviderModel(provider, body.model || allocation.rows[0].default_model);
    const project = await this.getProject(projectId);
    const settings = this.parseProjectSettings(project.settings).zyraAgent || {};
    if (!this.normalizeZyraCapabilities((settings as Body).capabilities).generation) {
      throw new BadRequestException({ error: "Test case generation is disabled for Zyra in this project. Enable it under Zyra → Settings → Capabilities.", code: "zyra_capability_disabled" });
    }
    const testcaseRange = String((settings as Body).testcaseRange || "1-10");
    const { requestedCount } = this.testcaseRangeConfig(testcaseRange);
    const story = String(body.userStory || body.story || "").trim();
    const context = String(body.context || body.prompt || "").trim();
    const acceptanceCriteria = String(body.acceptanceCriteria || "").trim();
    if (!story) throw new BadRequestException({ error: "story is required" });
    const jiraIssueKeys = normalizeJsonArray(body.jiraIssueKeys).map(String);
    const linearIssueKeys = normalizeJsonArray(body.linearIssueKeys).map(String);
    const knowledgeItemIds = normalizeJsonArray(body.knowledgeItemIds).map(String).filter(Boolean);
    const feedback = String(body.feedback || "").trim();
    const now = new Date().toISOString();
    const activityLog = [
      { actor: "user", stage: "todo", title: "Task created", detail: story, createdAt: now },
      { actor: "agent", stage: "todo", title: "Waiting for Zyra", detail: "Zyra will pick up this task and move it to In Progress.", createdAt: now }
    ];
    const sourceSummary = [
      { type: "story", title: "User story", detail: story.slice(0, 320) },
      ...(context ? [{ type: "context", title: "User Story Context", detail: context.slice(0, 320) }] : []),
      ...jiraIssueKeys.map((key) => ({ type: "jira", title: key, detail: "Selected Jira ticket queued for Zyra." })),
      ...linearIssueKeys.map((key) => ({ type: "linear", title: key, detail: "Selected Linear ticket queued for Zyra." }))
    ];
    const res = await this.db.query(
      `INSERT INTO ai_generation_requests
       (project_id, requested_by, provider, model, user_story, acceptance_criteria, custom_prompt, requested_count,
        generated_count, generated_payload, agent_name, task_status, feedback, context, jira_issue_keys, linear_issue_keys,
        token_input, token_output, token_total, source_summary, activity_log)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,'[]'::jsonb,$9,'todo',$10,$11,$12::jsonb,$13::jsonb,0,0,0,$14::jsonb,$15::jsonb)
       RETURNING *`,
      [
        projectId,
        uid,
        provider,
        model,
        story,
        acceptanceCriteria,
        context,
        requestedCount,
        ZYRA_AGENT_NAME,
        feedback,
        context,
        JSON.stringify(jiraIssueKeys),
        JSON.stringify(linearIssueKeys),
        JSON.stringify(sourceSummary),
        JSON.stringify(activityLog)
      ]
    );
    void this.processZyraTask(projectId, res.rows[0].id, { userId: uid, knowledgeItemIds }).catch(() => undefined);
    return {
      generationRequestId: res.rows[0].id,
      task: this.formatAiTask(res.rows[0]),
      provider,
      drafts: [],
      generatedCount: 0,
      tokenUsage: { input: 0, output: 0, total: 0 }
    };
  }

  // Records a terminal failure, but only if the row is still where processZyraTask left it
  // ('todo' if it never even got to the start UPDATE below, 'in_progress' otherwise). If the
  // user already closed/saved/resubmitted the task in the meantime, that action already moved
  // task_status past this point and must win — we only append a note to the activity log so the
  // failure isn't lost, without resurrecting or overwriting whatever the user set.
  private async markZyraTaskFailed(projectId: string, taskId: string, detail: string) {
    const failedAt = new Date().toISOString();
    const activity = [{ actor: "agent", stage: "failed", title: "Generation failed", detail, createdAt: failedAt }];
    const res = await this.db.query(
      `UPDATE ai_generation_requests SET task_status = 'failed', activity_log = activity_log || $3::jsonb, updated_at = now()
       WHERE id = $1 AND project_id = $2 AND task_status IN ('todo', 'in_progress') RETURNING id`,
      [taskId, projectId, JSON.stringify(activity)]
    );
    if (res.rowCount === 0) {
      const note = [{
        actor: "agent",
        stage: "failed",
        title: "Generation failed after task was already updated",
        detail: `${detail} (the task had already moved on by the time this was recorded, so its status was left as-is)`,
        createdAt: failedAt
      }];
      await this.db.query(
        "UPDATE ai_generation_requests SET activity_log = activity_log || $3::jsonb, updated_at = now() WHERE id = $1 AND project_id = $2",
        [taskId, projectId, JSON.stringify(note)]
      );
    }
  }

  private async processZyraTask(projectId: string, taskId: string, options: { userId: string; knowledgeItemIds?: string[] }) {
    // Hoisted out of the try block (rather than left as a `const` inside it) so the catch block
    // below can still name the provider/model when logging tokens from a response that arrived
    // and was billed but failed to parse.
    let provider = "unknown";
    let model = "unknown";
    try {
      const taskRes = await this.db.query("SELECT * FROM ai_generation_requests WHERE id = $1 AND project_id = $2", [taskId, projectId]);
      const task = taskRes.rows[0];
      if (!task) return;
      const allocation = await this.db.query(
        `SELECT k.provider, k.default_model, k.api_key, k.base_url, k.auth_header_name, k.auth_scheme
         FROM project_ai_key_allocations a
         JOIN workspace_ai_keys k ON k.id = a.workspace_ai_key_id
         WHERE a.project_id = $1 AND k.is_active = true`,
        [projectId]
      );
      if (!allocation.rows[0]) {
        // aiGenerate already checks this before inserting the row, so this only fires if the
        // allocation was revoked in the window between that check and this fire-and-forget job
        // running. It used to just `return` here, leaving the task stuck at 'todo' forever with
        // no error and no trace — indistinguishable from a task that was never picked up.
        await this.markZyraTaskFailed(projectId, taskId, "No active AI provider key is allocated to this project.");
        return;
      }
      const now = new Date().toISOString();
      const startedActivity = [{
        actor: "agent",
        stage: "in_progress",
        title: "Picked up task",
        detail: "Zyra moved this task from Todo to In Progress.",
        createdAt: now
      }];
      const startRes = await this.db.query(
        `UPDATE ai_generation_requests SET task_status = 'in_progress', activity_log = activity_log || $3::jsonb, updated_at = now()
         WHERE id = $1 AND project_id = $2 AND task_status = 'todo' RETURNING id`,
        [taskId, projectId, JSON.stringify(startedActivity)]
      );
      if (startRes.rowCount === 0) {
        // The task was already closed/updated by the user before Zyra could pick it up — don't
        // spend a provider call generating drafts nobody will see.
        return;
      }

      const story = String(task.user_story || "");
      const context = String(task.context || task.custom_prompt || "");
      const acceptanceCriteria = String(task.acceptance_criteria || "");
      const feedback = String(task.feedback || "");
      const jiraIssueKeys = normalizeJsonArray(task.jira_issue_keys).map(String);
      const linearIssueKeys = normalizeJsonArray(task.linear_issue_keys).map(String);
      const projectSettings = this.parseProjectSettings((await this.getProject(projectId)).settings).zyraAgent || {};
      const testcaseRange = String((projectSettings as Body).testcaseRange || "1-10");
      const { requestedCount } = this.testcaseRangeConfig(testcaseRange);
      provider = String(task.provider || allocation.rows[0].provider || "openai").toLowerCase();
      model = normalizeProviderModel(provider, task.model || allocation.rows[0].default_model);
      const knowledge = await this.knowledgeSnapshot(projectId, options.knowledgeItemIds || []);
      const jira = await this.jiraSnapshot(projectId, jiraIssueKeys);
      const linear = await this.linearSnapshot(projectId, linearIssueKeys);
      const existingTestcases = await this.existingTestcaseSnapshot(projectId, story, context);
      const aiResult = await this.generateZyraWithProvider({
        provider,
        model,
        apiKey: allocation.rows[0].api_key,
        baseUrl: allocation.rows[0].base_url,
        authHeaderName: allocation.rows[0].auth_header_name,
        authScheme: allocation.rows[0].auth_scheme,
        projectId,
        input: { story, context, acceptanceCriteria, feedback, knowledge, jira, linear, existingTestcases, requestedCount, testcaseRange }
      });
      const drafts = aiResult.drafts;
      const inputText = [
        story,
        context,
        acceptanceCriteria,
        feedback,
        knowledge.map((item) => `${item.title}\n${item.content}`).join("\n"),
        jira.map((t) => `${t.key} ${t.summary}`).join("\n"),
        linear.map((t) => `${t.key} ${t.summary}`).join("\n"),
        existingTestcases.map((tc) => `${tc.externalId} ${tc.title} ${tc.description}`).join("\n")
      ].join("\n");
      const tokenInput = aiResult.usage.input || estimateTokens(inputText);
      const tokenOutput = aiResult.usage.output || estimateTokens(JSON.stringify(drafts));
      const sourceSummary = [
        { type: "story", title: "User story", detail: story.slice(0, 320) },
        ...(context ? [{ type: "context", title: "User Story Context", detail: context.slice(0, 320) }] : []),
        ...knowledge.map((item) => ({ type: "knowledge_base", title: item.title, detail: truncateAtWordBoundary(item.content, 1500) })),
        ...jira.map((item) => ({ type: "jira", title: item.key, detail: `${item.summary} ${item.description}`.trim().slice(0, 320) })),
        ...linear.map((item) => ({ type: "linear", title: item.key, detail: `${item.summary} ${item.description}`.trim().slice(0, 320) })),
        ...existingTestcases.map((item) => ({ type: "existing_testcase", title: `${item.externalId} ${item.title}`, detail: item.description.slice(0, 320) }))
      ];
      const finishedAt = new Date().toISOString();
      const activity = [
        { actor: "agent", stage: "in_progress", title: "Read available sources", detail: `Considered ${knowledge.length} knowledge-base item(s), ${jira.length} Jira ticket(s), ${linear.length} Linear ticket(s), ${existingTestcases.length} existing testcase(s), Zyra memory, and the supplied story/context.`, createdAt: finishedAt },
        { actor: "agent", stage: "in_progress", title: "Generation plan", detail: this.zyraThinking({ story, context, acceptanceCriteria, feedback, knowledgeCount: knowledge.length, jiraCount: jira.length, linearCount: linear.length }), createdAt: finishedAt },
        { actor: "agent", stage: "in_review", title: "Generated testcase drafts", detail: `Generated ${drafts.length} testcase draft(s) with ${provider}${aiResult.requestId ? ` request ${aiResult.requestId}` : ""}. Cached input tokens: ${aiResult.usage.cached}.`, createdAt: finishedAt }
      ];
      const successRes = await this.db.query(
        `UPDATE ai_generation_requests
         SET generated_count = $3, generated_payload = $4::jsonb,
             token_input = $5, token_output = $6, token_total = $7,
             source_summary = $8::jsonb, activity_log = activity_log || $9::jsonb,
             task_status = 'in_review', updated_at = now()
         WHERE id = $1 AND project_id = $2 AND task_status = 'in_progress' RETURNING id`,
        [taskId, projectId, drafts.length, JSON.stringify(drafts), tokenInput, tokenOutput, tokenInput + tokenOutput, JSON.stringify(sourceSummary), JSON.stringify(activity)]
      );
      // Logged regardless of whether the row above actually applied (see the rowCount===0 branch
      // below) — the provider call happened and was billed either way; only whether the app kept
      // the resulting drafts is conditional. recordZyraTokenUsage never throws (see its own
      // try/catch), so awaiting it here cannot turn a logging hiccup into a failed task.
      await this.recordZyraTokenUsage(projectId, "task_generate", provider, model, aiResult.usage);
      if (successRes.rowCount === 0) {
        // The user closed/saved/resubmitted the task while generation was still running. Their
        // action already reflects the current truth, so don't resurrect it into 'in_review' or
        // silently replace generated_payload out from under whatever they already accepted —
        // just leave a trace that the drafts were produced but dropped.
        const droppedAt = new Date().toISOString();
        const note = [{
          actor: "agent",
          stage: "in_review",
          title: "Generated drafts discarded",
          detail: `Zyra finished generating ${drafts.length} testcase draft(s), but the task had already been updated in the meantime, so these drafts were not applied.`,
          createdAt: droppedAt
        }];
        await this.db.query(
          "UPDATE ai_generation_requests SET activity_log = activity_log || $3::jsonb, updated_at = now() WHERE id = $1 AND project_id = $2",
          [taskId, projectId, JSON.stringify(note)]
        );
        return;
      }
      await this.rememberZyraTurn({
        projectId,
        userId: options.userId,
        provider,
        model,
        key: allocation.rows[0],
        userMessage: story,
        outcome: `Generated ${drafts.length} testcase draft(s) using ${knowledge.length} knowledge-base item(s), ${jira.length} Jira ticket(s), and ${linear.length} Linear ticket(s). Coverage plan: ${this.zyraThinking({ story, context, acceptanceCriteria, feedback, knowledgeCount: knowledge.length, jiraCount: jira.length, linearCount: linear.length })}`
      });
    } catch (error) {
      // Nest builds HttpExceptions from an object payload, so `error.message` is the generic
      // status text ("Bad Request Exception") and the real cause — provider status, invalid
      // JSON, revoked key — is only in getResponse(). Reading `.message` here made every
      // failure indistinguishable in the activity log. extractAiErrorMessage unwraps it, the
      // same way the Zyra chat paths already do.
      const summary = this.extractAiErrorMessage(error) || "Zyra failed to generate testcase drafts.";
      // `error` alone is often still generic ("Claude testcase generation failed"); the provider's
      // own text lives in `detail`. Keep both so the activity log names the actual cause.
      const payload = typeof (error as { getResponse?: () => unknown })?.getResponse === "function"
        ? (error as { getResponse: () => unknown }).getResponse()
        : null;
      const providerDetail = payload && typeof payload === "object"
        ? String((payload as Record<string, unknown>).detail || "")
        : "";
      const detail = providerDetail && providerDetail !== summary ? `${summary} (${providerDetail})` : summary;
      this.logger.error(`Zyra task ${taskId} (project ${projectId}) failed: ${detail}`, error instanceof Error ? error.stack : undefined);
      // A provider response that arrived (and was billed) but failed to parse into usable drafts
      // carries its usage on the thrown error (see generateZyraWithOpenAi/Anthropic) — without
      // this, those tokens would silently vanish, which is exactly how 4 of the task-board's
      // 'failed' rows ended up with token_total=0 despite a real provider call having happened.
      const zyraUsage = (error as { zyraUsage?: { input?: number; output?: number; total?: number } } | null)?.zyraUsage;
      if (zyraUsage) {
        await this.recordZyraTokenUsage(projectId, "task_generate", provider, model, zyraUsage);
      }
      // task_status used to revert to 'todo' here — identical to a task that was never started,
      // so a failed generation was indistinguishable from a queued one anywhere the Kanban board
      // reads task_status. 'failed' is a dedicated terminal state the UI can badge distinctly.
      // markZyraTaskFailed only applies it if the row is still where this job left it (see the
      // comment on that method) — a user action that already moved the task on wins instead.
      await this.markZyraTaskFailed(projectId, taskId, detail);
    }
  }

  async aiHistory(projectId: string, userId: string | null | undefined, query: Body) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    const limit = pageNumber(query.limit, 50, 0, 100);
    const offset = pageNumber(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const res = await this.db.query(
      `SELECT * FROM ai_generation_requests WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [projectId, limit, offset]
    );
    return { list: res.rows.map(toCamel) };
  }

  async aiSave(projectId: string, userId: string | null | undefined, requestId: string, body: Body) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    if (!isUuid(requestId)) throw new NotFoundException({ error: "Zyra task not found" });
    const savedAt = new Date().toISOString();
    const events = [{ suiteId: body.suiteId || null, testcaseIds: body.testcaseIds || [], savedAt }];
    const activity = [{
      actor: "user",
      stage: "done",
      title: "Accepted and saved testcases",
      detail: `Saved ${Array.isArray(body.testcaseIds) ? body.testcaseIds.length : 0} testcase(s).`,
      createdAt: savedAt
    }];
    await this.db.query(
      `UPDATE ai_generation_requests
       SET saved_count = saved_count + $3, save_events = save_events || $4::jsonb,
           activity_log = activity_log || $5::jsonb, task_status = 'done', updated_at = now()
       WHERE id = $1 AND project_id = $2`,
      [requestId, projectId, Array.isArray(body.testcaseIds) ? body.testcaseIds.length : 0, JSON.stringify(events), JSON.stringify(activity)]
    );
  }

  async zyraFeedback(projectId: string, userId: string | null | undefined, taskId: string, body: Body) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    if (!isUuid(taskId)) throw new NotFoundException({ error: "Zyra task not found" });
    const existing = await this.db.query("SELECT * FROM ai_generation_requests WHERE id = $1 AND project_id = $2", [taskId, projectId]);
    if (!existing.rows[0]) throw new NotFoundException({ error: "Zyra task not found" });
    const statusBeforeFeedback = String(existing.rows[0].task_status || "");
    // Feedback only makes sense once there is something to review, or to retry after a failure.
    // Without this guard, feedback could be sent while processZyraTask was still mid-flight for
    // the same row — both would then race to write task_status/generated_payload for the same
    // task, and the "todo" this endpoint sets below could stomp the running job's own 'in_progress'
    // write (or vice versa) with neither side aware of the other.
    if (!["in_review", "failed"].includes(statusBeforeFeedback)) {
      throw new ConflictException({ error: `This task is currently "${statusBeforeFeedback}" and can't accept feedback right now. Wait for generation to finish first.` });
    }
    if (existing.rows[0].chat_session_id) {
      // Feedback here means "re-run the provider against the stored story/context" — a chat-linked
      // review row has neither; its drafts came from a conversational turn, not a single generation
      // request. The frontend never exposes this action for a chat-review batch, but reject
      // defensively rather than calling generateZyraWithProvider with an invalid provider/story.
      throw new BadRequestException({ error: "This batch came from a Zyra chat message and can't be regenerated with feedback here — continue the conversation instead." });
    }
    const feedbackText = String(body.feedback || "").trim();
    const referenceNote = String(body.referenceNote || "").trim();
    const additionalJiraIssueKeys = normalizeJsonArray(body.jiraIssueKeys).map(String).filter(Boolean);
    const additionalLinearIssueKeys = normalizeJsonArray(body.linearIssueKeys).map(String).filter(Boolean);
    const feedback = [
      feedbackText,
      referenceNote ? `Referenced docs or tickets for knowledge base:\n${referenceNote}` : ""
    ].filter(Boolean).join("\n\n");
    if (!feedback) throw new BadRequestException({ error: "feedback is required" });
    const allocation = await this.db.query(
      `SELECT k.provider, k.default_model, k.api_key, k.base_url, k.auth_header_name, k.auth_scheme
       FROM project_ai_key_allocations a
       JOIN workspace_ai_keys k ON k.id = a.workspace_ai_key_id
       WHERE a.project_id = $1 AND k.is_active = true`,
      [projectId]
    );
    if (!allocation.rows[0]) throw new BadRequestException({ error: "Zyra is inactive. Allocate an OpenAI or Claude key to this project first." });
    // `kind: "feedback"` is the explicit marker the frontend's Feedback tab filters on (see
    // isFeedbackActivity in TaskQuickViewPanel.tsx) — this is the only activity_log entry that
    // carries a reviewer's actual words rather than a status/process narration. Rows written
    // before this field existed have no `kind`; the frontend falls back to matching this exact
    // title for those, so old feedback still shows up correctly.
    const feedbackActivity = [{
      actor: "user",
      stage: "todo",
      kind: "feedback",
      title: "Review feedback submitted",
      detail: [
        feedbackText,
        referenceNote ? `References: ${referenceNote}` : "",
        additionalJiraIssueKeys.length ? `Jira tickets: ${additionalJiraIssueKeys.join(", ")}` : "",
        additionalLinearIssueKeys.length ? `Linear tickets: ${additionalLinearIssueKeys.join(", ")}` : ""
      ].filter(Boolean).join("\n"),
      createdAt: new Date().toISOString()
    }];
    const claimRes = await this.db.query(
      `UPDATE ai_generation_requests SET task_status = 'todo', feedback = $3, activity_log = activity_log || $4::jsonb, updated_at = now()
       WHERE id = $1 AND project_id = $2 AND task_status = $5 RETURNING *`,
      [taskId, projectId, feedback, JSON.stringify(feedbackActivity), statusBeforeFeedback]
    );
    if (claimRes.rowCount === 0) {
      // Lost the race: something else (another feedback submission, a close, a save) changed the
      // task's status between the read above and this write. Reject rather than blindly proceeding
      // against a row that has already moved on.
      throw new ConflictException({ error: "This task was just updated by another action. Reload and try again." });
    }
    const story = existing.rows[0].user_story;
    const context = existing.rows[0].context || existing.rows[0].custom_prompt || "";
    const acceptanceCriteria = existing.rows[0].acceptance_criteria || "";
    const jiraIssueKeys = Array.from(new Set([...normalizeJsonArray(existing.rows[0].jira_issue_keys).map(String), ...additionalJiraIssueKeys]));
    const linearIssueKeys = Array.from(new Set([...normalizeJsonArray(existing.rows[0].linear_issue_keys).map(String), ...additionalLinearIssueKeys]));
    // Re-read the project's current range (rather than trusting the stored requested_count alone)
    // so a regenerate keeps the same "generate exhaustively" instruction the initial run used —
    // otherwise this falls back to the generic "generate exactly N" phrasing, which reads very
    // differently to the model than "all possible cases".
    const zyraAgentSettings = await this.zyraAgentSettings(projectId);
    const testcaseRange = String(zyraAgentSettings.testcaseRange || "1-10");
    const requestedCount = Number(existing.rows[0].requested_count) || this.testcaseRangeConfig(testcaseRange).requestedCount;
    const provider = String(existing.rows[0].provider || allocation.rows[0].provider || "openai").toLowerCase();
    const model = normalizeProviderModel(provider, existing.rows[0].model || allocation.rows[0].default_model);
    // Regeneration is a real provider call (the same one processZyraTask makes for the initial
    // generation) and routinely takes tens of seconds. Fire it off the same way processZyraTask
    // does — the claim UPDATE above already moved the task to 'todo' and is what the caller needs
    // to see; the reviewer gets an immediate response instead of the request hanging until the
    // model finishes, and the existing todo/in_progress poll (see the frontend task-detail page)
    // picks up the regenerated drafts once processZyraFeedback below finishes.
    void this.processZyraFeedback(projectId, taskId, {
      userId: uid,
      story,
      context,
      acceptanceCriteria,
      feedback,
      feedbackText,
      referenceNote,
      jiraIssueKeys,
      linearIssueKeys,
      additionalJiraIssueKeys,
      additionalLinearIssueKeys,
      requestedCount,
      testcaseRange,
      provider,
      model,
      allocation: allocation.rows[0],
      previousSourceSummary: existing.rows[0].source_summary
    }).catch(() => undefined);
    return {
      generationRequestId: taskId,
      task: this.formatAiTask(claimRes.rows[0]),
      provider,
      drafts: [],
      generatedCount: 0,
      tokenUsage: { input: 0, output: 0, total: 0 }
    };
  }

  // Background continuation of zyraFeedback, split out so the HTTP request can return as soon as
  // the task is claimed instead of blocking on the provider call below (which routinely takes tens
  // of seconds) — mirrors processZyraTask's fire-and-forget shape for the initial generation.
  private async processZyraFeedback(
    projectId: string,
    taskId: string,
    options: {
      userId: string;
      story: string;
      context: string;
      acceptanceCriteria: string;
      feedback: string;
      feedbackText: string;
      referenceNote: string;
      jiraIssueKeys: string[];
      linearIssueKeys: string[];
      additionalJiraIssueKeys: string[];
      additionalLinearIssueKeys: string[];
      requestedCount: number;
      testcaseRange: string;
      provider: string;
      model: string;
      allocation: Body;
      previousSourceSummary: unknown;
    }
  ): Promise<void> {
    const {
      userId, story, context, acceptanceCriteria, feedback, feedbackText, referenceNote,
      jiraIssueKeys, linearIssueKeys, additionalJiraIssueKeys, additionalLinearIssueKeys,
      requestedCount, testcaseRange, provider, model, allocation, previousSourceSummary
    } = options;
    try {
      // These four snapshots are independent reads (knowledge base, Jira, Linear, existing
      // testcases) — gathering them concurrently instead of one after another cuts this stage's
      // wall time down to the slowest of the four instead of their sum, without changing what any
      // of them return.
      const [knowledge, jira, linear, existingTestcases] = await Promise.all([
        this.knowledgeSnapshot(projectId),
        this.jiraSnapshot(projectId, jiraIssueKeys),
        this.linearSnapshot(projectId, linearIssueKeys),
        this.existingTestcaseSnapshot(projectId, story, context)
      ]);
      const aiResult = await this.generateZyraWithProvider({
        provider,
        model,
        apiKey: allocation.api_key,
        baseUrl: allocation.base_url,
        authHeaderName: allocation.auth_header_name,
        authScheme: allocation.auth_scheme,
        projectId,
        input: { story, context, acceptanceCriteria, feedback, knowledge, jira, linear, existingTestcases, requestedCount, testcaseRange }
      });
      // Logged regardless of whether the UPDATE below actually applies (see the !responseRow
      // branch) — the provider call happened and was billed either way.
      await this.recordZyraTokenUsage(projectId, "task_regenerate", provider, model, aiResult.usage);
      const now = new Date().toISOString();
      const activity = [
        { actor: "agent", stage: "in_progress", title: "Moved task back to Todo", detail: "Zyra queued the task again after reviewer feedback.", createdAt: now },
        { actor: "agent", stage: "in_progress", title: "Re-read sources with feedback", detail: `Reused the same task and applied feedback against ${knowledge.length} knowledge-base item(s), ${jira.length} Jira ticket(s), ${linear.length} Linear ticket(s), ${existingTestcases.length} existing testcase(s), Zyra memory, and ${referenceNote ? "the referenced docs/tickets" : "the existing context"}.`, createdAt: now },
        { actor: "agent", stage: "in_review", title: "Regenerated testcase drafts", detail: `Updated this task with ${aiResult.drafts.length} regenerated draft(s). Cached input tokens: ${aiResult.usage.cached}.`, createdAt: now }
      ];
      const previousSources = normalizeJsonArray(previousSourceSummary);
      const nextSources = [
        ...previousSources,
        ...(referenceNote ? [{ type: "feedback_reference", title: "Reviewer reference", detail: referenceNote.slice(0, 320) }] : []),
        ...additionalJiraIssueKeys.map((key) => ({ type: "jira", title: key, detail: "Referenced by reviewer feedback." })),
        ...additionalLinearIssueKeys.map((key) => ({ type: "linear", title: key, detail: "Referenced by reviewer feedback." })),
        ...existingTestcases.map((item) => ({ type: "existing_testcase", title: `${item.externalId} ${item.title}`, detail: item.description.slice(0, 320) }))
      ];
      const res = await this.db.query(
        `UPDATE ai_generation_requests
         SET generated_count = $3, generated_payload = $4::jsonb, feedback = $5,
             token_input = token_input + $6, token_output = token_output + $7, token_total = token_total + $8,
             activity_log = activity_log || $9::jsonb, source_summary = $10::jsonb, jira_issue_keys = $11::jsonb,
             linear_issue_keys = $12::jsonb, task_status = 'in_review', updated_at = now()
         WHERE id = $1 AND project_id = $2 AND task_status = 'todo'
         RETURNING *`,
        [
          taskId,
          projectId,
          aiResult.drafts.length,
          JSON.stringify(aiResult.drafts),
          feedback,
          aiResult.usage.input,
          aiResult.usage.output,
          aiResult.usage.total,
          JSON.stringify(activity),
          JSON.stringify(nextSources),
          JSON.stringify(jiraIssueKeys),
          JSON.stringify(linearIssueKeys)
        ]
      );
      const responseRow = res.rows[0];
      if (!responseRow) {
        // Something else (a close/save from another tab) changed the task's status while the
        // provider call was in flight. Don't resurrect the row into 'in_review' out from under
        // whatever the concurrent action already set; just record that this happened.
        const droppedAt = new Date().toISOString();
        const note = [{
          actor: "agent",
          stage: "in_review",
          title: "Regenerated drafts discarded",
          detail: `Zyra regenerated ${aiResult.drafts.length} testcase draft(s) after this feedback, but the task had already been updated elsewhere in the meantime, so the regenerated drafts were not applied.`,
          createdAt: droppedAt
        }];
        await this.db.query(
          "UPDATE ai_generation_requests SET activity_log = activity_log || $3::jsonb, updated_at = now() WHERE id = $1 AND project_id = $2",
          [taskId, projectId, JSON.stringify(note)]
        );
        return;
      }
      await this.rememberZyraTurn({
        projectId,
        userId,
        provider,
        model,
        key: allocation,
        userMessage: `${story}\nReviewer feedback: ${feedbackText}`,
        outcome: [
          `Regenerated ${aiResult.drafts.length} testcase draft(s) after applying reviewer feedback.`,
          referenceNote ? `Reviewer references: ${referenceNote}` : "",
          additionalJiraIssueKeys.length ? `Jira references: ${additionalJiraIssueKeys.join(", ")}` : "",
          additionalLinearIssueKeys.length ? `Linear references: ${additionalLinearIssueKeys.join(", ")}` : ""
        ].filter(Boolean).join(" ")
      });
    } catch (error) {
      const summary = this.extractAiErrorMessage(error) || "Zyra failed to regenerate testcase drafts.";
      const payload = typeof (error as { getResponse?: () => unknown })?.getResponse === "function"
        ? (error as { getResponse: () => unknown }).getResponse()
        : null;
      const providerDetail = payload && typeof payload === "object"
        ? String((payload as Record<string, unknown>).detail || "")
        : "";
      const detail = providerDetail && providerDetail !== summary ? `${summary} (${providerDetail})` : summary;
      this.logger.error(`Zyra task ${taskId} (project ${projectId}) feedback regeneration failed: ${detail}`, error instanceof Error ? error.stack : undefined);
      // See processZyraTask's identical check: a response that arrived and was billed but failed
      // to parse still carries its usage on the thrown error.
      const zyraUsage = (error as { zyraUsage?: { input?: number; output?: number; total?: number } } | null)?.zyraUsage;
      if (zyraUsage) {
        await this.recordZyraTokenUsage(projectId, "task_regenerate", provider, model, zyraUsage);
      }
      // markZyraTaskFailed only marks 'failed' if the row is still 'todo'/'in_progress' — if a
      // concurrent close/save already moved it on, that action wins and this only leaves a note.
      await this.markZyraTaskFailed(projectId, taskId, detail);
    }
  }

  async zyraDeleteDraft(projectId: string, userId: string | null | undefined, taskId: string, draftIndex: number) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    if (!isUuid(taskId)) throw new NotFoundException({ error: "Zyra task not found" });
    const result = await this.db.transaction(async (client) => {
      // FOR UPDATE serializes this read-modify-write against any concurrent delete/edit/save on the
      // same row — without it, two concurrent deletes (or a delete racing an edit) each read the same
      // array, and whichever writes last silently discards the other's change.
      const existing = await client.query("SELECT * FROM ai_generation_requests WHERE id = $1 AND project_id = $2 FOR UPDATE", [taskId, projectId]);
      if (!existing.rows[0]) throw new NotFoundException({ error: "Zyra task not found" });
      const drafts = normalizeJsonArray(existing.rows[0].generated_payload);
      if (!Number.isInteger(draftIndex) || draftIndex < 0 || draftIndex >= drafts.length) {
        throw new BadRequestException({ error: "Invalid testcase draft index" });
      }
      const [removed] = drafts.splice(draftIndex, 1);
      const now = new Date().toISOString();
      const activity = [{
        actor: "user",
        stage: "in_review",
        title: "Deleted testcase draft",
        detail: String(removed?.title || removed?.draft?.title || `Draft ${draftIndex + 1}`),
        createdAt: now
      }];
      const res = await client.query(
        `UPDATE ai_generation_requests
         SET generated_payload = $3::jsonb, generated_count = $4,
             activity_log = activity_log || $5::jsonb, updated_at = now()
         WHERE id = $1 AND project_id = $2
         RETURNING *`,
        [taskId, projectId, JSON.stringify(drafts), drafts.length, JSON.stringify(activity)]
      );
      return res.rows[0];
    });
    return this.formatAiTask(result);
  }

  // Inline edit of one pending draft's fields — the review step's "edit" action. Task-board drafts
  // (opType defaults to "create" when absent) edit `.draft`; chat-staged update/archive proposals
  // edit `.fields` instead, since there's no new test case content to describe for those.
  async zyraEditDraft(projectId: string, userId: string | null | undefined, taskId: string, draftIndex: number, fields: Body) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    if (!isUuid(taskId)) throw new NotFoundException({ error: "Zyra task not found" });
    // Reuses the same field-length limits real testcases enforce, so an edit that would fail at
    // save time (title too long, etc.) is rejected here instead — at the point the user made it.
    this.assertTestcaseFieldLengths(fields);
    const result = await this.db.transaction(async (client) => {
      const existing = await client.query("SELECT * FROM ai_generation_requests WHERE id = $1 AND project_id = $2 FOR UPDATE", [taskId, projectId]);
      if (!existing.rows[0]) throw new NotFoundException({ error: "Zyra task not found" });
      if (existing.rows[0].task_status !== "in_review") {
        throw new ConflictException({ error: `This batch is currently "${existing.rows[0].task_status}" and can no longer be edited — it may have already been saved or closed elsewhere. Reload and try again.` });
      }
      const drafts = normalizeJsonArray(existing.rows[0].generated_payload);
      if (!Number.isInteger(draftIndex) || draftIndex < 0 || draftIndex >= drafts.length) {
        throw new BadRequestException({ error: "Invalid testcase draft index" });
      }
      const entry = { ...drafts[draftIndex] };
      const opType = entry.opType || "create";
      if (opType === "create") {
        // Same allowlist/sanitizing an update-op edit gets — keeps an edit from smuggling in a field
        // (suiteId, jiraIssueKey overrides) the lightweight editor was never meant to expose.
        entry.draft = { ...entry.draft, ...this.sanitizeZyraUpdateFields(fields) };
      } else {
        entry.fields = { ...entry.fields, ...this.sanitizeZyraUpdateFields(fields) };
      }
      drafts[draftIndex] = entry;
      const now = new Date().toISOString();
      const activity = [{
        actor: "user",
        stage: "in_review",
        title: "Edited testcase draft",
        detail: String(entry.draft?.title || entry.fields?.title || `Draft ${draftIndex + 1}`),
        createdAt: now
      }];
      const res = await client.query(
        `UPDATE ai_generation_requests
         SET generated_payload = $3::jsonb, activity_log = activity_log || $4::jsonb, updated_at = now()
         WHERE id = $1 AND project_id = $2
         RETURNING *`,
        [taskId, projectId, JSON.stringify(drafts), JSON.stringify(activity)]
      );
      return res.rows[0];
    });
    return this.formatAiTask(result);
  }

  async zyraCloseTask(projectId: string, userId: string | null | undefined, taskId: string) {
    await this.requireProjectAccess(this.requireUser(userId), projectId);
    if (!isUuid(taskId)) throw new NotFoundException({ error: "Zyra task not found" });
    const existing = await this.db.query("SELECT * FROM ai_generation_requests WHERE id = $1 AND project_id = $2", [taskId, projectId]);
    if (!existing.rows[0]) throw new NotFoundException({ error: "Zyra task not found" });
    if (existing.rows[0].task_status === "done") {
      // Already closed — a double-click or a second tab landing here after the first request
      // already won should be a harmless no-op, not a duplicate "Closed task" activity entry.
      return this.formatAiTask(existing.rows[0]);
    }
    const now = new Date().toISOString();
    const activity = [{
      actor: "user",
      stage: "done",
      title: "Closed task",
      detail: "Task closed from review without saving additional testcase drafts.",
      createdAt: now
    }];
    const res = await this.db.query(
      `UPDATE ai_generation_requests
       SET task_status = 'done', activity_log = activity_log || $3::jsonb, updated_at = now()
       WHERE id = $1 AND project_id = $2 AND task_status <> 'done'
       RETURNING *`,
      [taskId, projectId, JSON.stringify(activity)]
    );
    if (!res.rows[0]) {
      // Lost a race to a concurrent close (two tabs, double-click before the button disabled) —
      // return the current state instead of erroring on an action that already succeeded.
      const fresh = await this.db.query("SELECT * FROM ai_generation_requests WHERE id = $1 AND project_id = $2", [taskId, projectId]);
      return this.formatAiTask(fresh.rows[0]);
    }
    return this.formatAiTask(res.rows[0]);
  }

  // The actual save, run inside one transaction so the whole selected batch commits or none of it
  // does. Wrapped by zyraSave below, which retries the whole thing on an external-id collision —
  // a mid-transaction statement error poisons the rest of that transaction, so a single insert
  // can't be retried in place the way the single-item createTestCase does; the entire attempt is
  // retried instead, fresh, up to 5 times.
  //
  // Lock ordering, fixed across every call path (this method, zyraDeleteDraft, zyraEditDraft):
  // ai_generation_requests row first, then target testcase rows (sorted by id ascending), then the
  // per-project external-id advisory lock. Two calls that only ever acquire locks in this same
  // order can wait on each other but can never deadlock.
  private async zyraSaveAttempt(projectId: string, uid: string, taskId: string, body: Body, selectedIndexes: number[] | null) {
    // Resolved before the transaction: createSuite runs its own insert/commit, and Task-board drafts
    // (no per-draft suiteId) need one shared target suite chosen once for the whole batch. A chat-
    // staged create draft already carries its own suiteId from when the operation was proposed, and
    // takes precedence over this one below.
    let batchSuiteId: string | null = body.suiteId || null;
    if (!batchSuiteId && body.suiteName) {
      const suite = await this.createSuite(projectId, { name: body.suiteName });
      batchSuiteId = (suite as Body).id;
    }

    return this.db.transaction(async (client) => {
      // Serializes this whole save against any concurrent save/edit/delete/close on the same
      // batch — the loser blocks here until the winner commits, then sees the post-commit status
      // below and reacts to it instead of racing the write.
      const lockedRes = await client.query("SELECT * FROM ai_generation_requests WHERE id = $1 AND project_id = $2 FOR UPDATE", [taskId, projectId]);
      const existing = lockedRes.rows[0];
      if (!existing) throw new NotFoundException({ error: "Zyra task not found" });
      if (existing.task_status === "in_progress") {
        // Nothing generated yet for this row — saving now would either save nothing or save
        // drafts from a stale client-side cache that the still-running job is about to replace.
        throw new ConflictException({ error: "Zyra is still generating drafts for this task. Wait for it to finish before saving." });
      }
      if (!["in_review", "failed"].includes(String(existing.task_status))) {
        throw new ConflictException({ error: `This batch is currently "${existing.task_status}" — it looks like it was already saved or closed elsewhere. Reload and try again.` });
      }
      // Defense in depth: a plan downgraded between staging and saving shouldn't let a save through
      // just because the staging-time capability check already passed.
      const capabilities = await this.zyraProjectCapabilities(projectId);
      if (!capabilities.testcaseStorage) {
        throw new ForbiddenException({ error: "Test case storage is disabled for Zyra in this project — enable it under Zyra → Settings → Capabilities before saving." });
      }

      const drafts = normalizeJsonArray(existing.generated_payload);
      const selected = (selectedIndexes
        ? selectedIndexes.map((index) => (drafts[index] ? { ...drafts[index], __index: index } : null)).filter(Boolean)
        : drafts.map((draft: Body, index: number) => ({ ...draft, __index: index }))) as Body[];
      if (!selected.length) return { savedCount: 0, suiteId: batchSuiteId, testcases: [] };

      const jiraKeys = normalizeJsonArray(existing.jira_issue_keys).map(String).filter(Boolean);
      const linearKeys = normalizeJsonArray(existing.linear_issue_keys).map(String).filter(Boolean);
      const jiraIssueKey = jiraKeys[0] || null;
      const linearIssueKey = linearKeys[0] || null;
      const jiraTicket = jiraIssueKey
        ? await client.query("SELECT jira_url FROM jira_tickets WHERE project_id = $1 AND jira_issue_key = $2 LIMIT 1", [projectId, jiraIssueKey]).catch(() => ({ rows: [] as Body[] }))
        : { rows: [] as Body[] };
      const jiraUrl = jiraTicket.rows[0]?.jira_url || null;
      const linearTicket = linearIssueKey
        ? await client.query("SELECT linear_url FROM linear_tickets WHERE project_id = $1 AND linear_issue_key = $2 LIMIT 1", [projectId, linearIssueKey]).catch(() => ({ rows: [] as Body[] }))
        : { rows: [] as Body[] };
      const linearUrl = linearTicket.rows[0]?.linear_url || null;
      // A task carries either Jira or Linear keys, never both (the Requirements page creates one
      // task per ticket) — this just resolves whichever one applies for the "already linked, update
      // in place" lookup below. Chat-staged rows never set these, so this is always empty for them
      // — every chat create draft goes through the plain "create new testcase" branch.
      const existingLinked = jiraIssueKey
        ? await client.query("SELECT id FROM testcases WHERE project_id = $1 AND jira_issue_key = $2 AND deleted_at IS NULL ORDER BY updated_at ASC", [projectId, jiraIssueKey])
        : linearIssueKey
        ? await client.query("SELECT id FROM testcases WHERE project_id = $1 AND linear_issue_key = $2 AND deleted_at IS NULL ORDER BY updated_at ASC", [projectId, linearIssueKey])
        : { rows: [] as Body[] };

      // Pre-validate every update/archive target still exists before writing anything, so a target
      // deleted between staging and saving aborts the whole batch with a clear list, rather than an
      // unpredictable partial write inside an otherwise-atomic transaction.
      const updateOrArchive = selected.filter((entry) => entry.opType === "update" || entry.opType === "archive");
      if (updateOrArchive.length) {
        const ids = Array.from(new Set(updateOrArchive.map((entry) => String(entry.testcaseId)))).sort();
        const found = await client.query("SELECT id FROM testcases WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL FOR UPDATE", [ids]);
        const foundIds = new Set(found.rows.map((row) => String(row.id)));
        const stale = updateOrArchive.filter((entry) => !foundIds.has(String(entry.testcaseId)));
        if (stale.length) {
          throw new ConflictException({
            error: "Some selected drafts target a test case that no longer exists. Deselect them and try again.",
            staleDraftIndexes: stale.map((entry) => entry.__index)
          });
        }
      }

      const created: Body[] = [];
      const touched: Body[] = [];
      // existingLinked pairs positionally with create-type entries only ("the Nth create draft in
      // this save" ↔ "the Nth already-Jira/Linear-linked testcase, oldest first") — mirrors the
      // original single-item-per-transaction zyraSave exactly, which iterated `selected` under the
      // assumption every entry was a create (true for every Task-board batch, the only source that
      // ever populates jiraIssueKey/linearIssueKey in the first place). A running counter here keeps
      // that same pairing correct even though `selected` can now also hold update/archive entries.
      let createPosition = 0;
      for (const entry of selected) {
        const opType = entry.opType || "create";
        if (opType === "update" || opType === "archive") {
          await this.patchTestCaseFromZyraWithClient(client, entry.testcaseId, uid, entry.fields || {});
          const refreshed = await client.query("SELECT * FROM testcases WHERE id = $1", [entry.testcaseId]);
          const row = toCamel(refreshed.rows[0]);
          touched.push(row);
          await this.logProjectActivity(
            projectId, uid ?? null, opType === "archive" ? "zyra_archived" : "zyra_updated", "testcase", entry.testcaseId,
            `${row.externalId} - ${row.title}`, { source: existing.chat_session_id ? "zyra_chat" : "zyra_task", fields: entry.fields, reason: entry.reason || null }
          );
          continue;
        }
        const linkedIndex = createPosition++;
        const draft = entry.draft || entry;
        const targetSuiteId = draft.suiteId || batchSuiteId;
        const baseTags = Array.isArray(draft.tags) ? draft.tags.map(String) : [];
        const tags = Array.from(new Set([
          ...baseTags,
          "zyra",
          ...(jiraIssueKey ? [`jira:${jiraIssueKey}`] : []),
          ...(linearIssueKey ? [`linear:${linearIssueKey}`] : []),
          existingLinked.rows[linkedIndex]?.id ? "zyra-regenerated" : "zyra-generated"
        ])).join(",");
        const payload = {
          suiteId: targetSuiteId,
          title: draft.title,
          description: draft.description || draft.expectedSummary || "",
          preconditions: draft.preconditions || "",
          stepsJson: this.safeSteps(draft.stepsJson),
          priority: draft.priority || "P2",
          type: draft.type || "Functional",
          status: draft.status || "Draft",
          automationTags: tags,
          jiraIssueKey: draft.jiraIssueKey || jiraIssueKey,
          jiraUrl,
          linearIssueKey,
          linearUrl
        };
        this.assertTestcaseFieldLengths(payload);
        if (existingLinked.rows[linkedIndex]?.id) {
          const linkedId = existingLinked.rows[linkedIndex].id;
          const row = toCamel(await this.updateTestCaseWithClient(client, projectId, linkedId, uid, payload));
          touched.push({ id: linkedId, title: draft.title, updated: true, externalId: row.externalId });
        } else {
          const row = toCamel(await this.insertTestCaseWithClient(client, projectId, uid, payload));
          // The same audit action chat mode writes in applyZyraChatOperations. Both modes have to be
          // recorded identically or the agent's "tests generated" tile can only ever see one of them
          // — Basecamp 10212918496, where 33 chat-created cases were reported as 0.
          await this.logProjectActivity(projectId, uid ?? null, "zyra_created", "testcase", row.id, `${row.externalId} - ${row.title}`, { source: existing.chat_session_id ? "zyra_chat" : "zyra_task", taskId, reason: draft.reason || entry.reason || null });
          created.push(row);
          touched.push(row);
        }
      }

      const savedAt = new Date().toISOString();
      const events = [{ suiteId: batchSuiteId, testcaseIds: touched.map((item) => item.id), savedAt }];
      const saveActivity = [{ actor: "user", stage: "done", title: "Accepted and saved testcases", detail: `Saved ${touched.length} testcase(s).`, createdAt: savedAt }];
      // Task-board batches always resolve to 'done' on any save, partial selection or not — a single
      // generation request completes as one review, and that is unchanged here. A chat-staged batch
      // is different: a conversation naturally continues across turns, so saving only some of a
      // mixed create/update/archive batch leaves the rest in generated_payload, still 'in_review',
      // for a later Save/Edit/Discard — rather than orphaning them the moment ANY draft is saved.
      const savedIndexSet = new Set(selected.map((entry) => entry.__index));
      const remainingPayload = drafts.filter((_: Body, index: number) => !savedIndexSet.has(index));
      if (existing.chat_session_id && remainingPayload.length > 0) {
        await client.query(
          `UPDATE ai_generation_requests
           SET generated_payload = $3::jsonb, generated_count = $4, saved_count = saved_count + $5,
               save_events = save_events || $6::jsonb, activity_log = activity_log || $7::jsonb,
               task_status = 'in_review', updated_at = now()
           WHERE id = $1 AND project_id = $2`,
          [taskId, projectId, JSON.stringify(remainingPayload), remainingPayload.length, touched.length, JSON.stringify(events), JSON.stringify(saveActivity)]
        );
      } else {
        await client.query(
          `UPDATE ai_generation_requests
           SET saved_count = saved_count + $3, save_events = save_events || $4::jsonb,
               activity_log = activity_log || $5::jsonb, task_status = 'done', updated_at = now()
           WHERE id = $1 AND project_id = $2`,
          [taskId, projectId, touched.length, JSON.stringify(events), JSON.stringify(saveActivity)]
        );
      }
      return { savedCount: touched.length, suiteId: batchSuiteId, testcases: touched, remaining: remainingPayload.length };
    });
  }

  async zyraSave(projectId: string, userId: string | null | undefined, taskId: string, body: Body) {
    const uid = this.requireUser(userId);
    await this.requireProjectAccess(uid, projectId);
    if (!isUuid(taskId)) throw new NotFoundException({ error: "Zyra task not found" });

    // An explicitly-empty selectedDraftIndexes ("save nothing, I deselected everything") is
    // distinct from omitting the field entirely ("save everything" — kept for back-compat with
    // any existing caller that never sends a selection). Treating both the same used to mean a
    // deliberate empty selection silently saved every draft in the batch.
    const selectionProvided = Array.isArray(body.selectedDraftIndexes);
    const selectedIndexes = selectionProvided ? normalizeJsonArray(body.selectedDraftIndexes).map(Number) : null;
    if (selectedIndexes && selectedIndexes.length === 0) {
      return { savedCount: 0, suiteId: body.suiteId || null, testcases: [] };
    }

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.zyraSaveAttempt(projectId, uid, taskId, body, selectedIndexes);
      } catch (error) {
        const collided =
          (error as { code?: string })?.code === "23505" &&
          String((error as { constraint?: string })?.constraint || "") === "idx_testcases_project_external";
        if (!collided || attempt >= 5) throw error;
      }
    }
  }

  private parseProjectSettings(raw: unknown): Body {
    if (!raw) return {};
    if (typeof raw === "object") return raw as Body;
    if (typeof raw !== "string") return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private async zyraMemoryText(projectId: string): Promise<string> {
    const res = await this.db.query<{ content_text: string }>(
      "SELECT content_text FROM knowledge_documents WHERE project_id = $1 AND title = 'Zyra AI Memory' AND is_deleted = false ORDER BY updated_at DESC LIMIT 1",
      [projectId]
    );
    return String(res.rows[0]?.content_text || "").slice(0, 1500);
  }

  // Plain-text completion for internal note-taking (memory summarization) — unlike
  // zyraChatWithOpenAi/zyraChatWithAnthropic this does not force a JSON response shape,
  // since the caller wants a short prose/bullet answer, not a structured chat decision.
  private async summarizeForZyraMemory(provider: string, model: string, key: Body, prompt: string): Promise<string> {
    try {
      if (providerWire(provider) === "anthropic") {
        const chatUrl = normalizeAnthropicMessagesUrlFor(provider, key.base_url);
        const chatHeaders = this.providerAuthHeaders(provider, key.api_key, key.auth_header_name, key.auth_scheme);
        for (const candidate of providerModelCandidates(provider, model)) {
          const res = await fetch(chatUrl, {
            method: "POST",
            headers: chatHeaders,
            body: JSON.stringify({ model: candidate, max_tokens: 220, messages: [{ role: "user", content: prompt }] })
          });
          if (!res.ok) continue;
          const data = await res.json() as Body;
          const text = normalizeJsonArray(data.content).map((item) => item?.text || "").join("\n").trim();
          if (text) return text;
        }
        return "";
      }
      const headers = this.providerAuthHeaders(provider, String(key.api_key || ""), key.auth_header_name, key.auth_scheme);
      const res = await fetch(providerChatUrl(provider, key.base_url, model), {
        method: "POST",
        headers,
        body: JSON.stringify({ model, max_tokens: 220, messages: [{ role: "user", content: prompt }] })
      });
      if (!res.ok) return "";
      const data = await res.json() as Body;
      return String(data.choices?.[0]?.message?.content || "").trim();
    } catch {
      return "";
    }
  }

  // Turns one Zyra turn (user request + what Zyra did) into a short, meaningful memory
  // note via an actual LLM summarization pass, instead of dumping a hardcoded template.
  // Falls back to a trimmed request/outcome pair only if the summarization call fails,
  // so memory-writing never blocks or fails the underlying chat/task response.
  private async rememberZyraTurn(params: {
    projectId: string;
    userId: string | null;
    provider: string;
    model: string;
    key: Body;
    userMessage: string;
    outcome: string;
  }) {
    const priorMemory = await this.zyraMemoryText(params.projectId);
    const prompt = [
      "You maintain a running memory file for an AI test-engineering assistant named Zyra so it can recall context across future sessions.",
      "Read the latest turn below and write 1-3 short bullet points capturing only durable, reusable facts: what the user actually wants, any constraints/preferences/decisions they stated, and what was produced or changed as a result.",
      "Do not restate token counts, provider/model names, or generic boilerplate. Do not repeat facts already present in the existing memory below.",
      "Plain text bullets starting with \"- \", no headings, no JSON, no code fences.",
      "",
      "Existing memory (older notes, for context only):",
      priorMemory || "None yet.",
      "",
      "Latest turn:",
      `User: ${params.userMessage}`,
      `Result: ${params.outcome}`
    ].join("\n");
    const summary = (await this.summarizeForZyraMemory(params.provider, params.model, params.key, prompt))
      .split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 6).join("\n");
    const entry = summary || `- ${params.userMessage.slice(0, 200)}\n- ${params.outcome.slice(0, 200)}`;
    await this.rememberZyraMemory(params.projectId, params.userId, entry);
  }

  // Zyra's own rolling scratchpad memory — distinct from the human-curated "AI Memory"
  // document type (which requires approval before being trusted). This note is always
  // read/written directly since Zyra is both its author and its only reader; it's stored
  // as a plain 'general' document (not 'ai_memory') so it never needs approval, just filed
  // under the project's AI Memory folder for visibility.
  private async kbAiMemoryFolderId(projectId: string): Promise<string | null> {
    const folder = await this.db.query<{ id: string }>(
      `SELECT kf.id FROM knowledge_folders kf
       JOIN knowledge_folders root ON kf.parent_folder_id = root.id AND root.is_root = true AND root.project_id = $1
       WHERE kf.project_id = $1 AND kf.name = 'AI Memory' AND kf.is_deleted = false LIMIT 1`,
      [projectId]
    );
    if (folder.rows[0]?.id) return folder.rows[0].id;
    const root = await this.db.query<{ id: string }>("SELECT id FROM knowledge_folders WHERE project_id = $1 AND is_root = true LIMIT 1", [projectId]);
    return root.rows[0]?.id || null;
  }

  private async rememberZyraMemory(projectId: string, userId: string | null, entry: string) {
    const title = "Zyra AI Memory";
    const folderId = await this.kbAiMemoryFolderId(projectId);
    if (!folderId) return;

    const existing = await this.db.query<{ id: string; content_text: string }>(
      "SELECT id, content_text FROM knowledge_documents WHERE project_id = $1 AND title = $2 AND is_deleted = false ORDER BY updated_at DESC LIMIT 1",
      [projectId, title]
    );
    const stampedEntry = `## ${new Date().toISOString()}\n${entry.trim()}`.slice(0, 2500);
    const project = await this.db.query<{ organization_id: string }>("SELECT organization_id FROM projects WHERE id = $1", [projectId]);
    if (existing.rows[0]) {
      const content = [stampedEntry, String(existing.rows[0].content_text || "")].filter(Boolean).join("\n\n").slice(0, 20000);
      await this.db.query(
        "UPDATE knowledge_documents SET content_text = $2, content_html = $3, updated_at = now() WHERE id = $1",
        [existing.rows[0].id, content, `<pre>${escapeHtml(content)}</pre>`]
      );
      this.enqueueEmbedding(project.rows[0]?.organization_id, projectId, "document", existing.rows[0].id, "updated");
      return;
    }
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO knowledge_documents (organization_id, project_id, folder_id, title, content_text, content_html, document_type, status, is_ai_generated, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'general', 'published', true, $7, $7) RETURNING id`,
      [project.rows[0]?.organization_id, projectId, folderId, title, stampedEntry, `<pre>${escapeHtml(stampedEntry)}</pre>`, userId]
    );
    if (inserted.rows[0]?.id) this.enqueueEmbedding(project.rows[0]?.organization_id, projectId, "document", inserted.rows[0].id, "created");
  }

  private async knowledgeSnapshot(projectId: string, selectedItemIds: string[] = []): Promise<Array<{ title: string; content: string }>> {
    const selected = Array.from(new Set(selectedItemIds.filter(Boolean)));
    const values: any[] = [projectId];
    // Only approved AI-memory documents are trusted context; every other document type
    // (general notes, requirement mirrors, etc.) is trusted unconditionally, same as before.
    let filter = "project_id = $1 AND is_deleted = false AND (document_type != 'ai_memory' OR status = 'approved')";
    if (selected.length) {
      values.push(selected);
      filter += ` AND (id = ANY($${values.length}::uuid[]) OR title = 'Zyra AI Memory')`;
    }
    // knowledgeItemIds selection (task generation) only ever names documents (see the frontend
    // picker), so an explicit selection should stay document-only rather than pulling in files —
    // skip firing the files query at all in that case, rather than firing and discarding it.
    const [res, filesRes] = await Promise.all([
      this.db.query(
        `SELECT title, content_text FROM knowledge_documents
         WHERE ${filter}
         ORDER BY CASE WHEN title = 'Zyra AI Memory' THEN 0 ELSE 1 END, updated_at DESC
         LIMIT 12`,
        values
      ),
      selected.length
        ? Promise.resolve({ rows: [] as any[] })
        : this.db.query(
            `SELECT original_file_name, file_extension, extracted_text, extraction_status FROM knowledge_files
             WHERE project_id = $1 AND is_deleted = false
             ORDER BY updated_at DESC
             LIMIT 8`,
            [projectId]
          )
    ]);
    const documents = res.rows.map((row) => ({
      title: row.title || "Knowledge base item",
      content: String(row.content_text || "").slice(0, 1500)
    }));
    if (selected.length) return documents;

    const files = filesRes.rows.map((row) => ({
      title: row.original_file_name || "Uploaded file",
      content: row.extracted_text ? String(row.extracted_text).slice(0, 1500) : this.knowledgeFileFallbackContent(row.file_extension, row.extraction_status)
    }));
    return [...documents, ...files];
  }

  private knowledgeFileFallbackContent(fileExtension: string | null, extractionStatus: string | null): string {
    const ext = fileExtension || "file";
    if (extractionStatus === "pending") {
      return `Uploaded file (.${ext}) — transcription is still in progress; mention it exists but do not invent its contents yet.`;
    }
    if (extractionStatus === "failed") {
      return `Uploaded file (.${ext}) — automatic transcription failed for this file; mention it exists but do not invent its contents.`;
    }
    if (extractionStatus === "unsupported") {
      return `Uploaded file (.${ext}) — transcription requires an OpenAI key allocated to this project (Workspace → AI Providers); mention it exists but do not invent its contents.`;
    }
    return `Uploaded file (.${ext}) — no extractable text is available for this file type; mention that it exists but do not invent its contents.`;
  }

  private extractQuotedPhrases(message: string): string[] {
    const phrases = new Set<string>();
    for (const pattern of [/"([^"]{2,80})"/g, /'([^']{2,80})'/g]) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(message))) {
        const value = match[1].trim();
        if (value) phrases.add(value);
      }
    }
    return Array.from(phrases);
  }

  // Neither knowledgeSnapshot (recency) nor rag retrieval (embeddings/full-text over document
  // content) can resolve a request that names a knowledge-base folder directly, e.g. "get details
  // from knowledge base 'EAD-11215' folder" — so when the message quotes a name or mentions a
  // Jira-key-shaped token, look it up by folder name and surface its documents/files explicitly.
  private async knowledgeFolderSnapshot(projectId: string, message: string, jiraKeys: string[]): Promise<Array<{ title: string; content: string }>> {
    const candidates = Array.from(new Set([...this.extractQuotedPhrases(message), ...jiraKeys])).slice(0, 5);
    if (!candidates.length) return [];
    const foldersRes = await this.db.query(
      `SELECT id, name FROM knowledge_folders WHERE project_id = $1 AND is_deleted = false AND name ILIKE ANY($2::text[]) LIMIT 5`,
      [projectId, candidates.map((value) => `%${value}%`)]
    ).catch(() => ({ rows: [] as Body[] }));
    if (!foldersRes.rows.length) return [];

    const folderIds = foldersRes.rows.map((row) => row.id);
    const folderNames = foldersRes.rows.map((row) => row.name).join(", ");
    const [docsRes, filesRes] = await Promise.all([
      this.db.query(
        `SELECT title, content_text FROM knowledge_documents WHERE folder_id = ANY($1::uuid[]) AND is_deleted = false ORDER BY updated_at DESC LIMIT 12`,
        [folderIds]
      ).catch(() => ({ rows: [] as Body[] })),
      this.db.query(
        `SELECT original_file_name, file_extension, extracted_text, extraction_status FROM knowledge_files WHERE folder_id = ANY($1::uuid[]) AND is_deleted = false ORDER BY updated_at DESC LIMIT 8`,
        [folderIds]
      ).catch(() => ({ rows: [] as Body[] }))
    ]);
    const documents = docsRes.rows.map((row) => ({
      title: row.title || "Knowledge base item",
      content: String(row.content_text || "").slice(0, 1500)
    }));
    const files = filesRes.rows.map((row) => ({
      title: row.original_file_name || "Uploaded file",
      content: row.extracted_text ? String(row.extracted_text).slice(0, 1500) : this.knowledgeFileFallbackContent(row.file_extension, row.extraction_status)
    }));
    if (!documents.length && !files.length) {
      return [{ title: `Knowledge base folder: ${folderNames}`, content: "This folder was found by name but currently has no documents or files in it." }];
    }
    return [{ title: `Knowledge base folder: ${folderNames}`, content: "" }, ...documents, ...files];
  }

  private async existingTestcaseSnapshot(
    projectId: string,
    story: string,
    context: string
  ): Promise<Array<{ externalId: string; title: string; description: string; priority: string; status: string; stepsSummary: string }>> {
    const searchText = [story, context].join(" ").toLowerCase();
    const terms = Array.from(new Set(searchText.split(/[^a-z0-9]+/).filter((word) => word.length > 3))).slice(0, 8);
    const values: any[] = [projectId];
    let orderBy = "updated_at DESC";
    if (terms.length) {
      values.push(terms.map((term) => `%${term}%`));
      orderBy = `CASE WHEN lower(title) LIKE ANY($2::text[]) OR lower(coalesce(description, '')) LIKE ANY($2::text[]) THEN 0 ELSE 1 END, updated_at DESC`;
    }
    const res = await this.db.query(
      `SELECT external_id, title, description, priority, status, steps
       FROM testcases
       WHERE project_id = $1 AND deleted_at IS NULL
       ORDER BY ${orderBy}
       LIMIT 25`,
      values
    );
    return res.rows.map((row) => ({
      externalId: row.external_id || "",
      title: String(row.title || "Untitled testcase").slice(0, 240),
      description: String(row.description || "").slice(0, 500),
      priority: String(row.priority || "P2"),
      status: String(row.status || "Draft"),
      stepsSummary: JSON.stringify(normalizeJsonArray(row.steps)).slice(0, 800)
    }));
  }

  // Words that carry no selectivity in a QA request — "generate test cases covering the login flow"
  // is only really about "login". Without stripping these, term matching against tickets or
  // testcases matches almost everything and the relevance ordering becomes noise.
  // Held as STEMS and matched against suffix-stripped candidates, so "cover", "covers", "covering"
  // and "coverage" all collapse to one entry. Enumerating inflections by hand is what made the old
  // intent regexes wrong ("generate" matched, "generating" did not) — not repeating it here.
  private static readonly ZYRA_STOPWORD_STEMS = new Set([
    "test", "testcase", "case", "generat", "creat", "writ", "draft", "pleas", "cover", "coverag",
    "scenario", "suite", "flow", "verif", "validat", "check", "should", "would", "could", "about",
    "with", "from", "into", "need", "want", "make", "give", "show", "list", "them", "this", "that",
    "these", "those", "there", "their", "have", "been", "will", "more", "some", "also", "use",
    "using", "base"
  ]);

  private isZyraStopword(word: string): boolean {
    if (LegacyService.ZYRA_STOPWORD_STEMS.has(word)) return true;
    for (const suffix of ["ing", "age", "ed", "es", "s", "e", "y"]) {
      if (word.length > suffix.length + 2 && word.endsWith(suffix)) {
        if (LegacyService.ZYRA_STOPWORD_STEMS.has(word.slice(0, -suffix.length))) return true;
      }
    }
    return false;
  }

  private zyraSearchTerms(text: string, limit = 8): string[] {
    const words = String(text || "").toLowerCase().split(/[^a-z0-9]+/);
    const terms = words.filter((word) => word.length > 3 && !this.isZyraStopword(word));
    return Array.from(new Set(terms)).slice(0, limit);
  }

  // Jira context for generation. jiraSnapshot only ever returns tickets whose keys were typed into
  // the message, which meant "generate test cases for the login flow" read ZERO tickets even with
  // Jira connected and every ticket synced — Zyra depended entirely on the Jira mirror happening to
  // surface through knowledge-base retrieval. This adds the deliberate step: explicit keys first
  // (with jiraSnapshot's live-API fallback), then the most relevant synced tickets to fill up to
  // `limit`. Relevance is required, not padded — an unrelated ticket is worse than no ticket.
  private async relevantJiraSnapshot(
    projectId: string,
    message: string,
    mentionedKeys: string[],
    limit = 8
  ): Promise<Array<{ key: string; summary: string; description: string }>> {
    const explicit = mentionedKeys.length ? await this.jiraSnapshot(projectId, mentionedKeys) : [];
    if (explicit.length >= limit) return explicit.slice(0, limit);
    const terms = this.zyraSearchTerms(message);
    if (!terms.length) return explicit;
    const res = await this.db.query(
      `SELECT jira_issue_key, summary, description
       FROM jira_tickets
       WHERE project_id = $1
         AND (lower(summary) LIKE ANY($2::text[])
              OR lower(coalesce(description, '')) LIKE ANY($2::text[])
              OR lower(coalesce(labels, '')) LIKE ANY($2::text[]))
       ORDER BY CASE WHEN lower(summary) LIKE ANY($2::text[]) THEN 0 ELSE 1 END,
                jira_updated_at DESC NULLS LAST
       LIMIT $3`,
      [projectId, terms.map((term) => `%${term}%`), limit]
    ).catch(() => ({ rows: [] as Body[] }));
    const seen = new Set(explicit.map((item) => item.key));
    const matched = res.rows
      .map((row) => ({
        key: String(row.jira_issue_key || ""),
        summary: String(row.summary || ""),
        description: String(row.description || "").slice(0, 4000)
      }))
      .filter((item) => item.key && !seen.has(item.key));
    return [...explicit, ...matched].slice(0, limit);
  }

  // Jira tickets are mirrored into the knowledge base by the integration sync, titled "KEY: summary"
  // (see IntegrationSyncDocumentBuilder). Counting them makes the "sources read" line in a reply
  // honest: reporting "0 Jira ticket(s)" while a dozen retrieved knowledge items were Jira tickets
  // reads as "Jira is not connected", which is the wrong conclusion.
  private countZyraJiraSourcedKnowledge(knowledge: Array<{ title: string }>): number {
    return knowledge.filter((item) => /^[A-Z][A-Z0-9]+-\d+\s*:/.test(String(item.title || "").trim())).length;
  }

  private async jiraSnapshot(projectId: string, keys: string[]): Promise<Array<{ key: string; summary: string; description: string }>> {
    const selectedKeys = Array.from(new Set(keys.map((key) => key.trim()).filter(Boolean)));
    if (!selectedKeys.length) return [];
    const res = await this.db.query(
      `SELECT jira_issue_key, summary, description FROM jira_tickets
       WHERE project_id = $1 AND jira_issue_key = ANY($2::text[])`,
      [projectId, selectedKeys]
    ).catch(() => ({ rows: [] as any[] }));
    const byKey = new Map<string, { key: string; summary: string; description: string }>(
      res.rows.map((row) => [
        String(row.jira_issue_key),
        {
          key: String(row.jira_issue_key),
          summary: String(row.summary || ""),
          description: String(row.description || "")
        }
      ])
    );

    const missingKeys = selectedKeys.filter((key) => !byKey.has(key));
    let jiraConnected = true;
    if (missingKeys.length) {
      const connection = await this.getJiraConnection(projectId, true).catch(() => null);
      jiraConnected = Boolean(connection);
      if (connection) {
        const { baseUrl, headers } = this.jiraBaseUrlAndAuth(connection);
        // Fetched concurrently rather than one key at a time — each key is an independent Jira
        // HTTP round trip plus its own upsert, so N sequential round trips were paying N times the
        // latency of a single one for no benefit; byKey.set is safe here since Node's event loop
        // never interleaves the synchronous portions of these callbacks.
        await Promise.all(missingKeys.map(async (key) => {
          const issue = await this.jiraFetch<Body>(
            `${baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,issuetype,status,priority,assignee,reporter,labels,created,updated`,
            { headers }
          ).catch(() => null);
          if (!issue) return;
          const fields = (issue.fields || {}) as Body;
          const summary = String(fields.summary || "");
          const description = jiraDescriptionToText(fields.description);
          byKey.set(key, { key, summary, description });
          await this.db.query(
            `INSERT INTO jira_tickets (
               project_id, jira_connection_id, jira_issue_id, jira_issue_key, summary, description,
               issue_type, status, priority, assignee, reporter, labels, jira_created_at, jira_updated_at, jira_url, synced_at
             )
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
             ON CONFLICT (jira_connection_id, jira_issue_id, project_id) DO UPDATE SET
               jira_issue_key = EXCLUDED.jira_issue_key,
               summary = EXCLUDED.summary,
               description = EXCLUDED.description,
               issue_type = EXCLUDED.issue_type,
               status = EXCLUDED.status,
               priority = EXCLUDED.priority,
               assignee = EXCLUDED.assignee,
               reporter = EXCLUDED.reporter,
               labels = EXCLUDED.labels,
               jira_created_at = EXCLUDED.jira_created_at,
               jira_updated_at = EXCLUDED.jira_updated_at,
               jira_url = EXCLUDED.jira_url,
               synced_at = now()`,
            [
              projectId,
              connection.id,
              String(issue.id || key),
              String(issue.key || key),
              summary,
              description,
              String(fields.issuetype?.name || ""),
              String(fields.status?.name || ""),
              String(fields.priority?.name || ""),
              String(fields.assignee?.displayName || ""),
              String(fields.reporter?.displayName || ""),
              normalizeJsonArray(fields.labels).join(", "),
              fields.created || null,
              fields.updated || null,
              `${connection.site_url}/browse/${issue.key || key}`
            ]
          ).catch(() => undefined);
        }));
      }
    }

    return selectedKeys.map((key) => byKey.get(key) || {
      key,
      summary: "Selected Jira ticket",
      description: jiraConnected
        ? "This key was not found in the local Jira cache or via the live Jira API — it may not exist, or may belong to a project this Jira connection cannot access."
        : "Jira is not connected for this project, so this key could not be looked up. Tell the user Jira isn't connected (Project Settings → Integrations → Jira) rather than implying the ticket itself is missing."
    });
  }

  // Only reads the linear_tickets sync cache, unlike jiraSnapshot's live-API fallback for missing
  // keys — the Requirements page only ever selects keys it just listed from that same cache, so a
  // cache miss here would mean the ticket was deleted/unsynced, not "not synced yet".
  private async linearSnapshot(projectId: string, keys: string[]): Promise<Array<{ key: string; summary: string; description: string }>> {
    const selectedKeys = Array.from(new Set(keys.map((key) => key.trim()).filter(Boolean)));
    if (!selectedKeys.length) return [];
    const res = await this.db.query(
      `SELECT linear_issue_key, summary, description FROM linear_tickets
       WHERE project_id = $1 AND linear_issue_key = ANY($2::text[])`,
      [projectId, selectedKeys]
    ).catch(() => ({ rows: [] as any[] }));
    const byKey = new Map<string, { key: string; summary: string; description: string }>(
      res.rows.map((row) => [
        String(row.linear_issue_key),
        {
          key: String(row.linear_issue_key),
          summary: String(row.summary || ""),
          description: String(row.description || "")
        }
      ])
    );
    return selectedKeys.map((key) => byKey.get(key) || {
      key,
      summary: "Selected Linear ticket",
      description: "Ticket details were not available from the local cache, but the selected key was included for Zyra context."
    });
  }

  private async generateZyraWithProvider(params: {
    provider: string;
    model: string;
    apiKey: string;
    baseUrl?: string | null;
    authHeaderName?: string | null;
    authScheme?: string | null;
    projectId: string;
    input: ZyraGenerationInput;
  }): Promise<ZyraAiResult> {
    const provider = String(params.provider || "openai").toLowerCase();
    if (providerWire(provider) === "anthropic") return this.generateZyraWithAnthropic(params);
    return this.generateZyraWithOpenAi(params);
  }

  private zyraSystemPrompt(): string {
    return [
      "You are Zyra the Test Generator, an AI testcase generation agent.",
      "Generate practical, detailed QA testcases from the supplied product story, user context, Jira/Linear tickets, knowledge-base sources, Zyra memory, and existing testcase repository context.",
      "Review existing testcases before generating. Do not duplicate existing coverage; instead fill gaps, deepen weak coverage, or create clearly distinct edge cases.",
      "Prioritize edge cases, boundary values, negative paths, permissions, data integrity, state transitions, and traceability.",
      "Return only valid JSON matching this shape: {\"drafts\":[{\"title\":\"\",\"preconditions\":\"\",\"stepsJson\":\"[]\",\"expectedSummary\":\"\",\"priority\":\"P1|P2|P3\",\"tags\":[\"\"]}]}",
      "Do not include markdown fences, explanations, comments, or text before or after the JSON object.",
      "stepsJson must be a JSON string containing an array of step objects with step, action, and expected fields."
    ].join("\n");
  }

  private zyraStaticSourcePrompt(input: ZyraGenerationInput): string {
    const knowledge = input.knowledge.length
      ? input.knowledge.map((item, index) => `KB ${index + 1}: ${item.title}\n${item.content}`).join("\n\n")
      : "No knowledge-base notes were available.";
    const jira = input.jira.length
      ? input.jira.map((item) => `${item.key}: ${item.summary}\n${item.description}`).join("\n\n")
      : "No Jira tickets were selected.";
    const linear = input.linear.length
      ? input.linear.map((item) => `${item.key}: ${item.summary}\n${item.description}`).join("\n\n")
      : "No Linear tickets were selected.";
    const existingTestcases = input.existingTestcases.length
      ? input.existingTestcases.map((item) => `${item.externalId}: ${item.title}\nPriority: ${item.priority}; Status: ${item.status}\n${item.description}\nSteps: ${item.stepsSummary}`).join("\n\n")
      : "No existing testcases were available.";
    return [
      "Static project sources for prompt caching:",
      "Knowledge base:",
      knowledge,
      "Jira tickets:",
      jira,
      "Linear tickets:",
      linear,
      "Existing testcases to review for context and duplicate avoidance:",
      existingTestcases
    ].join("\n\n");
  }

  private testcaseRangeConfig(range: string): { requestedCount: number; instruction: string } {
    switch (range) {
      case "minimum":
        return { requestedCount: 4, instruction: "Generate only the minimum testcases needed — aim for 1 to 3 highly targeted scenarios covering the most critical paths. Never generate more than 5 testcases." };
      case "10-30":
        return { requestedCount: 25, instruction: "Generate between 10 and 25 testcases. Cover the main flows, key edge cases, negative scenarios, and important variations. Aim for at least 10 distinct testcases." };
      case "all":
        return { requestedCount: 50, instruction: "Generate as many testcases as possible — cover every applicable flow, edge case, boundary value, negative path, and variation. Be exhaustive and do not cap yourself." };
      default: // "1-10"
        return { requestedCount: 10, instruction: "Generate between 1 and 10 testcases. Prioritise quality and relevance; include edge cases only where genuinely important." };
    }
  }

  private zyraDynamicTaskPrompt(input: ZyraGenerationInput): string {
    const instruction = input.testcaseRange
      ? this.testcaseRangeConfig(input.testcaseRange).instruction
      : `Generate exactly ${input.requestedCount} testcase drafts.`;
    return [
      instruction,
      `Story:\n${input.story}`,
      input.acceptanceCriteria ? `Acceptance criteria:\n${input.acceptanceCriteria}` : "",
      input.context ? `User context:\n${input.context}` : "",
      input.feedback ? `Reviewer feedback to apply to this same task:\n${input.feedback}` : "",
      "For every draft, use the selected knowledge, Jira context, Zyra memory, and existing testcase repository context.",
      "Make sure every draft is specific, detailed, testable, and not a duplicate of existing testcases or another generated draft."
    ].filter(Boolean).join("\n\n");
  }

  private normalizeAiDrafts(raw: unknown, requestedCount: number): Body[] {
    const candidates = this.extractAiDraftCandidates(raw);
    if (!candidates.length) throw new BadRequestException({ error: "AI testcase generation returned no testcase drafts" });
    return candidates.slice(0, requestedCount).map((item, index) => {
      const draft = item as Body;
      const tags = Array.isArray(draft.tags) ? draft.tags.map(String) : ["zyra"];
      return {
        title: String(draft.title || `Generated testcase ${index + 1}`).slice(0, 240),
        preconditions: String(draft.preconditions || "Required test data and user permissions are available."),
        stepsJson: typeof draft.stepsJson === "string" ? draft.stepsJson : JSON.stringify(draft.steps || []),
        expectedSummary: String(draft.expectedSummary || draft.expected || "The workflow behaves as expected."),
        priority: String(draft.priority || (index < 2 ? "P1" : "P2")),
        tags
      };
    });
  }

  // Strict parse -> repaired parse (same repair parseModelJson uses for chat replies, since
  // models produce the same "almost valid JSON" here — an unescaped quote or literal newline
  // inside a long stepsJson/expectedSummary string) -> per-object salvage. The salvage step
  // matters on its own: a response cut off mid-array by a token limit is not fixable by
  // re-escaping characters, but the complete draft objects earlier in the array still are.
  // Only when every strategy yields zero drafts does the caller see "no testcase drafts" —
  // one bad character (or a truncated final entry) no longer fails the whole batch.
  private extractAiDraftCandidates(raw: unknown): unknown[] {
    if (typeof raw !== "string") {
      return Array.isArray(raw) ? raw : normalizeJsonArray((raw as Body)?.drafts);
    }
    const text = this.extractJsonPayload(raw);
    if (!text) return [];
    for (const attempt of [text, this.repairLooseJson(text)]) {
      try {
        const parsed = JSON.parse(attempt);
        const list = Array.isArray(parsed) ? parsed : normalizeJsonArray((parsed as Body)?.drafts);
        if (list.length) return list;
      } catch { /* fall through to per-object salvage */ }
    }
    return this.salvageDraftObjects(text);
  }

  // Walks the "drafts" (or top-level) array and parses each top-level {...} entry on its own,
  // keeping whichever ones are complete/valid and dropping only the broken one — which is
  // always at most the final entry when the cause is truncation.
  private salvageDraftObjects(text: string): unknown[] {
    const arrayStart = text.indexOf("[");
    if (arrayStart < 0) return [];
    const drafts: unknown[] = [];
    let index = arrayStart + 1;
    while (index < text.length) {
      while (index < text.length && /[\s,]/.test(text[index])) index += 1;
      if (text[index] !== "{") break;
      const objectText = this.extractBalancedJson(text.slice(index));
      if (!objectText) break; // truncated mid-object — nothing further is recoverable
      try {
        drafts.push(JSON.parse(objectText));
      } catch {
        try {
          drafts.push(JSON.parse(this.repairLooseJson(objectText)));
        } catch { /* drop this one malformed draft, keep the rest */ }
      }
      index += objectText.length;
    }
    return drafts;
  }

  private extractJsonPayload(raw: string): string {
    const text = raw.trim();
    if (!text) return text;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = (fenced?.[1] || text).trim();
    if (candidate.startsWith("{") || candidate.startsWith("[")) {
      const balanced = this.extractBalancedJson(candidate);
      if (balanced) return balanced;
    }
    const firstObject = candidate.indexOf("{");
    const firstArray = candidate.indexOf("[");
    const starts = [firstObject, firstArray].filter((index) => index >= 0);
    if (!starts.length) return candidate;
    const start = Math.min(...starts);
    return this.extractBalancedJson(candidate.slice(start)) || candidate.slice(start).trim();
  }

  private extractBalancedJson(text: string): string | null {
    const open = text[0];
    const close = open === "{" ? "}" : open === "[" ? "]" : "";
    if (!close) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === "\"") inString = false;
        continue;
      }
      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === open) depth += 1;
      else if (char === close) {
        depth -= 1;
        if (depth === 0) return text.slice(0, index + 1);
      }
    }
    return null;
  }

  // Models routinely emit *almost* valid JSON: an unescaped quote or a literal newline
  // inside a long markdown string value. Strict JSON.parse rejects the whole payload, and
  // without this repair the raw envelope leaks into the chat as the visible reply.
  // Walks the text and escapes control chars plus any quote that is not a real terminator
  // (a terminator is followed only by whitespace and one of , : } ] or end of input).
  private repairLooseJson(text: string): string {
    const out: string[] = [];
    let inString = false;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (!inString) {
        out.push(char);
        if (char === "\"") inString = true;
        continue;
      }
      if (escaped) {
        out.push(char);
        escaped = false;
        continue;
      }
      if (char === "\\") {
        out.push(char);
        escaped = true;
        continue;
      }
      if (char === "\"") {
        let lookahead = index + 1;
        while (lookahead < text.length && /\s/.test(text[lookahead])) lookahead += 1;
        const next = text[lookahead];
        if (lookahead >= text.length || next === "," || next === ":" || next === "}" || next === "]") {
          out.push(char);
          inString = false;
        } else {
          out.push("\\\"");
        }
        continue;
      }
      if (char === "\n") out.push("\\n");
      else if (char === "\r") out.push("\\r");
      else if (char === "\t") out.push("\\t");
      else if (char < " ") out.push(" ");
      else out.push(char);
    }
    return out.join("");
  }

  // Last resort when even the repaired payload will not parse: pull the string fields we
  // actually render straight out of the text so the user still sees prose, never an envelope.
  private salvageJsonStringFields(text: string, fields: string[]): Body | null {
    const salvaged: Body = {};
    for (const field of fields) {
      const start = text.indexOf(`"${field}"`);
      if (start < 0) continue;
      const colon = text.indexOf(":", start + field.length + 2);
      if (colon < 0) continue;
      let cursor = colon + 1;
      while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
      if (text[cursor] !== "\"") continue;
      cursor += 1;
      const chars: string[] = [];
      let escaped = false;
      for (; cursor < text.length; cursor += 1) {
        const char = text[cursor];
        if (escaped) {
          if (char === "n") chars.push("\n");
          else if (char === "r") chars.push("\r");
          else if (char === "t") chars.push("\t");
          else chars.push(char);
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === "\"") {
          let lookahead = cursor + 1;
          while (lookahead < text.length && /\s/.test(text[lookahead])) lookahead += 1;
          const next = text[lookahead];
          if (lookahead >= text.length || next === "," || next === "}") break;
        }
        chars.push(char);
      }
      const value = chars.join("").trim();
      if (value) salvaged[field] = value;
    }
    if (!Object.keys(salvaged).length) return null;
    // Marks the fragment as recovered rather than a clean parse, so callers (and reconcileZyraReply)
    // can tell that action/operations/testcases were lost to truncation, not genuinely absent.
    salvaged.salvaged = true;
    return salvaged;
  }

  // Strict parse → repaired parse → textual field salvage. Returns null only when the text
  // holds no recoverable JSON object at all, which callers surface as plain prose.
  private parseModelJson(raw: string, salvageFields: string[] = ["reply", "reasoningSummary"]): Body | null {
    const payload = this.extractJsonPayload(String(raw || "").trim());
    if (!payload) return null;
    try {
      const parsed = JSON.parse(payload) as Body;
      if (parsed && typeof parsed === "object") return parsed;
    } catch { /* fall through to repair */ }
    try {
      const parsed = JSON.parse(this.repairLooseJson(payload)) as Body;
      if (parsed && typeof parsed === "object") return parsed;
    } catch { /* fall through to field salvage */ }
    return this.salvageJsonStringFields(payload, salvageFields);
  }

  // Plain JSON-mode completion for internal tool calls that need a small, arbitrary JSON
  // shape (not the fixed Zyra chat decision schema) — used to plan the scenario todo list
  // for "all possible cases" generation without pulling in the full chat-decision prompt.
  private async zyraJsonCompletion(provider: string, model: string, key: Body, systemPrompt: string, userPrompt: string): Promise<Body> {
    if (providerWire(provider) === "anthropic") {
      const res = await fetch(normalizeAnthropicMessagesUrlFor(provider, key.base_url), {
        method: "POST",
        headers: this.providerAuthHeaders(provider, key.api_key, key.auth_header_name, key.auth_scheme),
        body: JSON.stringify({
          model: providerModelCandidates(provider, model)[0],
          max_tokens: 2000,
          system: [{ type: "text", text: systemPrompt }],
          messages: [{ role: "user", content: userPrompt }]
        }),
        signal: LegacyService.zyraProviderSignal(LegacyService.ZYRA_ROUTER_TIMEOUT_MS)
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({} as Body)) as Body;
        const rawMessage = String(errBody.error?.message || errBody.error || res.status);
        throw new Error(this.describeProviderError("anthropic", res.status, rawMessage) || `Anthropic request failed: ${rawMessage}`);
      }
      const data = await res.json() as Body;
      const text = normalizeJsonArray(data.content).map((item: Body) => item?.text || "").join("\n");
      const parsed = this.parseModelJson(text, []);
      if (!parsed) throw new Error("Anthropic returned no parseable JSON.");
      const usage = data.usage || {};
      const cached = Number(usage.cache_read_input_tokens || 0) + Number(usage.cache_creation_input_tokens || 0);
      const input = Number(usage.input_tokens || 0) + cached;
      const output = Number(usage.output_tokens || 0);
      return { ...parsed, __zyraUsage: { input, output, total: input + output } };
    }
    const headers = this.providerAuthHeaders(provider, String(key.api_key || ""), key.auth_header_name, key.auth_scheme);
    const res = await fetch(providerChatUrl(provider, key.base_url, model), {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      }),
      signal: LegacyService.zyraProviderSignal(LegacyService.ZYRA_ROUTER_TIMEOUT_MS)
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({} as Body)) as Body;
      const rawMessage = String(errBody.error?.message || errBody.error || res.status);
      throw new Error(this.describeProviderError(String(key.provider || "openai"), res.status, rawMessage) || `OpenAI request failed: ${rawMessage}`);
    }
    const data = await res.json() as Body;
    const content = String(data.choices?.[0]?.message?.content || "{}");
    const parsed = this.parseModelJson(content, []);
    if (!parsed) throw new Error("OpenAI returned no parseable JSON.");
    const usage = data.usage || {};
    return { ...parsed, __zyraUsage: { input: Number(usage.prompt_tokens || 0), output: Number(usage.completion_tokens || 0), total: Number(usage.total_tokens || 0) } };
  }

  // Plans a todo list of distinct scenarios to cover for an exhaustive ("all possible cases")
  // generation request. This call is cheap and safe from truncation — it only asks for short
  // labels, never full testcase detail — so it can never hit the same output-token ceiling
  // that a single "generate 50 full testcases" call did.
  private async planZyraChatScenarios(params: {
    projectId: string;
    provider: string;
    model: string;
    key: Body;
    message: string;
    knowledge: Array<{ title: string; content: string }>;
    existingTestcases: ZyraGenerationInput["existingTestcases"];
    maxScenarios: number;
  }): Promise<string[]> {
    const systemPrompt = "You are Zyra, an expert test engineer planning exhaustive test coverage. Break the request into a todo list of distinct, non-overlapping testable scenarios (happy paths, edge cases, negative paths, boundary values). Each scenario becomes exactly one testcase later, so keep each one narrow and specific — do not write full testcase detail here, only short labels.";
    const userPrompt = [
      `Request: ${params.message}`,
      "",
      "Knowledge base:",
      params.knowledge.map((item) => `${item.title}\n${item.content}`).join("\n\n") || "None.",
      "",
      "Existing testcases (avoid proposing scenarios that already have coverage):",
      params.existingTestcases.map((tc) => `${tc.externalId} | ${tc.title}`).join("\n") || "None.",
      "",
      `Return ONLY JSON: {"scenarios": ["short scenario label", ...]}. List up to ${params.maxScenarios} scenarios, ordered from most to least important. No markdown, no commentary.`
    ].join("\n");
    const parsed = await this.zyraJsonCompletion(params.provider, params.model, params.key, systemPrompt, userPrompt);
    await this.recordZyraTokenUsage(params.projectId, "chat_plan", params.provider, params.model, parsed.__zyraUsage || {});
    const scenarios = normalizeJsonArray(parsed.scenarios).map((item) => String(item || "").trim()).filter(Boolean);
    return scenarios.slice(0, params.maxScenarios);
  }

  private async generateZyraWithOpenAi(params: {
    provider: string;
    model: string;
    apiKey: string;
    baseUrl?: string | null;
    authHeaderName?: string | null;
    authScheme?: string | null;
    projectId: string;
    input: ZyraGenerationInput;
  }): Promise<ZyraAiResult> {
    const openAiBody: Body = {
      model: params.model || "gpt-4o",
      messages: [
        { role: "system", content: this.zyraSystemPrompt() },
        { role: "user", content: this.zyraStaticSourcePrompt(params.input) },
        { role: "user", content: this.zyraDynamicTaskPrompt(params.input) }
      ],
      response_format: { type: "json_object" },
      temperature: 0.2
    };
    if (params.provider === "openai") {
      openAiBody.prompt_cache_key = `zyra:${params.projectId}`;
    }
    if (params.provider === "openai" && /^(gpt-5|gpt-4\.1)/.test(String(openAiBody.model))) {
      openAiBody.prompt_cache_retention = "24h";
    }
    const headers = this.providerAuthHeaders(params.provider, params.apiKey, params.authHeaderName ?? null, params.authScheme ?? null);
    const response = await fetch(providerChatUrl(params.provider, params.baseUrl, String(openAiBody.model)), {
      method: "POST",
      headers,
      body: JSON.stringify(openAiBody),
      signal: LegacyService.zyraProviderSignal(LegacyService.ZYRA_GENERATE_TIMEOUT_MS)
    });
    const body = await response.json().catch(() => ({} as Body)) as Body;
    if (!response.ok) {
      const rawMessage = String(body.error?.message || body.error || response.statusText);
      const friendly = this.describeProviderError(params.provider, response.status, rawMessage);
      throw new BadRequestException({
        error: friendly || `${providerDefinition(params.provider)?.label || params.provider} testcase generation failed`,
        detail: rawMessage,
        ...(this.isProviderAuthError(response.status, rawMessage) ? { code: "ai_key_invalid" } : {})
      });
    }
    const content = body.choices?.[0]?.message?.content;
    const rawUsage = body.usage || {};
    const usage = {
      input: Number(rawUsage.prompt_tokens || 0),
      output: Number(rawUsage.completion_tokens || 0),
      total: Number(rawUsage.total_tokens || 0),
      cached: Number(rawUsage.prompt_tokens_details?.cached_tokens || 0)
    };
    // The provider already billed for this response by the time we're parsing it, so a parse
    // failure below must not lose that — attach the usage we already have to the thrown error
    // instead of letting normalizeAiDrafts's exception discard it (see zyraUsage callers).
    let drafts: Body[];
    try {
      drafts = this.normalizeAiDrafts(content, params.input.requestedCount);
    } catch (err) {
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { zyraUsage: usage });
    }
    return {
      drafts,
      usage,
      requestId: response.headers.get("x-request-id") || undefined
    };
  }

  private async generateZyraWithAnthropic(params: {
    provider: string;
    model: string;
    apiKey: string;
    baseUrl?: string | null;
    authHeaderName?: string | null;
    authScheme?: string | null;
    projectId: string;
    input: ZyraGenerationInput;
  }): Promise<ZyraAiResult> {
    let lastMessage = "";
    const anthropicUrl = normalizeAnthropicMessagesUrl(params.baseUrl);
    const anthropicHeaders = this.buildAnthropicAuthHeaders(params.apiKey, params.authHeaderName ?? null, params.authScheme ?? null);
    for (const model of providerModelCandidates(params.provider, params.model)) {
      const response = await fetch(anthropicUrl, {
        method: "POST",
        headers: anthropicHeaders,
        body: JSON.stringify({
          model,
          // 4000 was a fixed ceiling regardless of how many testcases were requested — a
          // batch of just 5 detailed drafts could already exceed it, truncating the JSON
          // mid-array and failing to parse. Scale with requestedCount instead, capped at
          // 16000 (the threshold above which the SDK guidance calls for streaming).
          max_tokens: Math.min(16000, 2000 + params.input.requestedCount * 1500),
          // No temperature: Claude Sonnet 5 / Opus 5 / Opus 4.7+ reject a non-default
          // sampling parameter with a 400, and the model picker can now surface those.
          // It bought little anyway — temperature never guaranteed identical outputs.
          system: [
            {
              type: "text",
              text: `${this.zyraSystemPrompt()}\n\n${this.zyraStaticSourcePrompt(params.input)}`,
              cache_control: { type: "ephemeral" }
            }
          ],
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: this.zyraDynamicTaskPrompt(params.input) }]
            }
          ]
        }),
        signal: LegacyService.zyraProviderSignal(LegacyService.ZYRA_GENERATE_TIMEOUT_MS)
      });
      const body = await response.json().catch(() => ({} as Body)) as Body;
      if (!response.ok) {
        const rawMessage = String(body.error?.message || body.error || response.statusText);
        const friendly = this.describeProviderError("anthropic", response.status, rawMessage);
        lastMessage = friendly || rawMessage;
        // Auth/permission failures are not model-specific — stop trying candidates and surface a clear message.
        if (this.isProviderAuthError(response.status, rawMessage)) {
          throw new BadRequestException({ error: lastMessage, detail: rawMessage, code: "ai_key_invalid" });
        }
        if (!/model|not.?found|invalid/i.test(rawMessage)) break;
        continue;
      }
      const content = normalizeJsonArray(body.content).map((item) => item?.text || "").join("\n").trim();
      const rawUsage = body.usage || {};
      const cached = Number(rawUsage.cache_read_input_tokens || 0) + Number(rawUsage.cache_creation_input_tokens || 0);
      const input = Number(rawUsage.input_tokens || 0) + cached;
      const output = Number(rawUsage.output_tokens || 0);
      const usage = { input, output, total: input + output, cached };
      // See generateZyraWithOpenAi: the response is already billed, so a parse failure below must
      // still surface these tokens to the caller via zyraUsage on the thrown error.
      let drafts: Body[];
      try {
        drafts = this.normalizeAiDrafts(content, params.input.requestedCount);
      } catch (err) {
        throw Object.assign(err instanceof Error ? err : new Error(String(err)), { zyraUsage: usage });
      }
      return {
        drafts,
        usage,
        requestId: response.headers.get("request-id") || undefined
      };
    }
    throw new BadRequestException({ error: "Claude testcase generation failed", detail: lastMessage || "No compatible Claude model was accepted." });
  }

  private generateZyraDrafts(input: {
    story: string;
    context: string;
    acceptanceCriteria: string;
    feedback: string;
    knowledge: Array<{ title: string; content: string }>;
    jira: Array<{ key: string; summary: string; description: string }>;
    requestedCount: number;
  }) {
    const focus = [
      "happy path",
      "required field boundary",
      "invalid data rejection",
      "permission edge",
      "empty state",
      "duplicate submission",
      "slow network recovery",
      "cross-browser behavior",
      "multi-tab consistency",
      "audit and traceability"
    ];
    const knowledgeHint = input.knowledge[0]?.title || "project knowledge";
    const jiraHint = input.jira[0]?.key ? `${input.jira[0].key} ${input.jira[0].summary}` : "linked requirements";
    const feedbackHint = input.feedback ? ` Incorporate feedback: ${input.feedback}` : "";
    return Array.from({ length: input.requestedCount }).map((_, index) => {
      const angle = focus[index % focus.length];
      const title = `${this.compactTitle(input.story)} - ${angle}`;
      const steps = [
        { step: 1, action: `Review the story, ${jiraHint}, and ${knowledgeHint}.`, expected: "Relevant requirement context is available." },
        { step: 2, action: `Prepare data for the ${angle} scenario.`, expected: "Test data matches the scenario intent." },
        { step: 3, action: `Execute the workflow described in the story.${feedbackHint}`, expected: `The system handles the ${angle} scenario correctly.` },
        { step: 4, action: "Verify stored state, UI messages, and any linked audit output.", expected: "The final result is traceable and consistent." }
      ];
      return {
        title,
        preconditions: input.context || input.acceptanceCriteria || "User has access to the target feature and required project data exists.",
        stepsJson: JSON.stringify(steps),
        expectedSummary: `Covers ${angle} behavior for: ${input.story}`,
        priority: index < 2 ? "P1" : "P2",
        tags: ["zyra", angle.replaceAll(" ", "-")]
      };
    });
  }

  private zyraThinking(input: {
    story: string;
    context: string;
    acceptanceCriteria: string;
    feedback: string;
    knowledgeCount: number;
    jiraCount: number;
    linearCount?: number;
  }): string {
    const signals = [
      input.context ? "project context" : null,
      input.acceptanceCriteria ? "acceptance criteria" : null,
      input.knowledgeCount ? `${input.knowledgeCount} knowledge-base source(s)` : null,
      input.jiraCount ? `${input.jiraCount} Jira ticket(s)` : null,
      input.linearCount ? `${input.linearCount} Linear ticket(s)` : null,
      input.feedback ? "review feedback" : null
    ].filter(Boolean).join(", ");
    return `I checked ${signals || "the submitted story"} and planned coverage across happy path, negative, boundary, permission, data-state, and traceability risks before drafting the testcases.`;
  }

  private async zyraChatWithOpenAi(key: Body, model: string, context: string, message: string): Promise<Body> {
    const body = {
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: context },
        { role: "user", content: message }
      ]
    };
    const provider = String(key.provider || "openai").toLowerCase();
    const headers = this.providerAuthHeaders(provider, String(key.api_key || ""), key.auth_header_name, key.auth_scheme);
    const res = await fetch(providerChatUrl(provider, key.base_url, model), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: LegacyService.zyraProviderSignal(LegacyService.ZYRA_ROUTER_TIMEOUT_MS)
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({} as Body)) as Body;
      const rawMessage = String(errBody.error?.message || errBody.error || res.status);
      throw new Error(this.describeProviderError(String(key.provider || "openai"), res.status, rawMessage) || `OpenAI chat failed: ${rawMessage}`);
    }
    const data = await res.json() as Body;
    const content = String(data.choices?.[0]?.message?.content || "{}");
    // Real provider usage, not the estimateTokens() guess callers used to fall back to — this was
    // sitting right here in the response and being thrown away.
    const usage = data.usage || {};
    const zyraUsage = { input: Number(usage.prompt_tokens || 0), output: Number(usage.completion_tokens || 0), total: Number(usage.total_tokens || 0) };
    const parsed = this.parseModelJson(content);
    if (parsed) return { ...parsed, __zyraUsage: zyraUsage };
    // AI returned prose instead of JSON — surface it as a plain answer so the
    // user sees the actual message rather than a SyntaxError string.
    return { reply: content.trim().slice(0, 5000), action: "answer", actionType: "answer", operations: [], testcases: [], __zyraUsage: zyraUsage };
  }

  private async zyraChatWithAnthropic(key: Body, model: string, context: string, message: string): Promise<Body> {
    let lastStatus = "";
    const chatUrl = normalizeAnthropicMessagesUrl(key.base_url);
    const chatHeaders = this.buildAnthropicAuthHeaders(key.api_key, key.auth_header_name, key.auth_scheme);
    for (const candidate of providerModelCandidates(String(key.provider || "anthropic"), model)) {
      const body = {
        model: candidate,
        max_tokens: 2200,
        // Claude 4.6 and later reject a trailing assistant prefill with a 400, so the
        // opening brace can't be forced any more. Ask for a bare envelope instead;
        // parseModelJson still strips a markdown fence or preamble if one slips through.
        system: `${context}\n\nRespond with the raw JSON envelope only — no markdown fence, no preamble, no trailing commentary.`,
        messages: [
          { role: "user", content: message }
        ]
      };
      const res = await fetch(chatUrl, {
        method: "POST",
        headers: chatHeaders,
        body: JSON.stringify(body),
        signal: LegacyService.zyraProviderSignal(LegacyService.ZYRA_ROUTER_TIMEOUT_MS)
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({} as Body)) as Body;
        const rawStatus = String(data.error?.message || data.error || res.status);
        const friendly = this.describeProviderError("anthropic", res.status, rawStatus);
        lastStatus = friendly || rawStatus;
        // Auth/permission failures won't be fixed by another model candidate — fail fast and clearly.
        if (this.isProviderAuthError(res.status, rawStatus)) {
          throw new Error(lastStatus);
        }
        if (!/model|not.?found|invalid/i.test(rawStatus)) break;
        continue;
      }
      const data = await res.json() as Body;
      const rawText = normalizeJsonArray(data.content).map((item) => item?.text || "").join("\n").trim();
      // Real provider usage, not the estimateTokens() guess callers used to fall back to — this was
      // sitting right here in the response and being thrown away.
      const usage = data.usage || {};
      const cached = Number(usage.cache_read_input_tokens || 0) + Number(usage.cache_creation_input_tokens || 0);
      const zyraUsage = { input: Number(usage.input_tokens || 0) + cached, output: Number(usage.output_tokens || 0), total: 0 };
      zyraUsage.total = zyraUsage.input + zyraUsage.output;
      const parsed = this.parseModelJson(rawText || "{}");
      if (parsed) return { ...parsed, __zyraUsage: zyraUsage };
      // AI returned prose instead of JSON — surface it as a plain answer so the
      // user sees the actual message rather than a SyntaxError string.
      return { reply: rawText.slice(0, 5000), action: "answer", actionType: "answer", operations: [], testcases: [], __zyraUsage: zyraUsage };
    }
    throw new Error(`Claude chat failed: ${lastStatus || "No compatible model was accepted."}`);
  }

  private sanitizeZyraReply(raw: unknown, fallback: string): string {
    let text = String(raw ?? "").trim();
    // AI occasionally nests a full JSON blob inside the reply field — unwrap it. The tolerant
    // parse matters here: a malformed envelope must never reach the user as visible chat text.
    if (text.startsWith("{") || text.startsWith("[")) {
      const inner = this.parseModelJson(text);
      const innerReply = typeof inner?.reply === "string" ? inner.reply.trim() : "";
      text = innerReply || "";
    }
    return (text || fallback).slice(0, 5000);
  }

  // `intent` here is the router's own decision (intentFromZyraModelAction), so this validates and
  // shapes what the model asked for rather than second-guessing it: operations must be well-formed
  // and reference something real, and rows are only returned for actions that display them.
  private normalizeZyraChatDecision(raw: Body, message: string, existingTestcases: ZyraGenerationInput["existingTestcases"], intent: ZyraChatIntent): ZyraChatDecision {
    const modelActionType = ["answer", "create", "update", "archive", "suite", "mixed"].includes(String(raw.actionType))
      ? String(raw.actionType) as ZyraChatDecision["actionType"]
      : "answer";
    const mutationIntent = intent === "create" || intent === "update" || intent === "archive" || intent === "suite";
    const tableIntent = mutationIntent || intent === "list";
    const actionType = intent === "suite" ? "suite" : (mutationIntent ? modelActionType : "answer");
    const opTypes = ["create", "update", "archive", "create_suite", "move_to_suite"];
    const operations = normalizeJsonArray(raw.operations)
      .map((op) => {
        const type = opTypes.includes(String(op?.type)) ? String(op.type) : (intent === "suite" ? "move_to_suite" : "create");
        const externalIds = normalizeJsonArray(op?.externalIds).map((value) => String(value).trim()).filter(Boolean);
        const testcaseIds = normalizeJsonArray(op?.testcaseIds).map((value) => String(value).trim()).filter(Boolean);
        return {
          type: type as ZyraChatDecision["operations"][number]["type"],
          testcaseId: op?.testcaseId ? String(op.testcaseId) : undefined,
          externalId: op?.externalId ? String(op.externalId) : undefined,
          externalIds: externalIds.length ? externalIds.slice(0, 200) : undefined,
          testcaseIds: testcaseIds.length ? testcaseIds.slice(0, 200) : undefined,
          allExisting: op?.allExisting === true,
          fromLastPlan: op?.fromLastPlan === true,
          suiteName: op?.suiteName ? String(op.suiteName).trim().slice(0, 128) : undefined,
          suiteId: op?.suiteId ? String(op.suiteId).trim() : undefined,
          draft: op?.draft && typeof op.draft === "object" ? op.draft : undefined,
          fields: op?.fields && typeof op.fields === "object" ? op.fields : undefined,
          reason: op?.reason ? String(op.reason).slice(0, 500) : undefined
        };
      })
      .filter((op) => {
        if (op.type === "create") return !!op.draft;
        if (op.type === "create_suite") return !!op.suiteName;
        if (op.type === "move_to_suite") return (!!op.suiteName || !!op.suiteId) && (op.allExisting || op.fromLastPlan || !!op.externalIds?.length || !!op.testcaseIds?.length);
        return op.testcaseId || op.externalId; // update / archive
      })
      .slice(0, LegacyService.ZYRA_CHAT_MAX_OPERATIONS);
    const testcases = tableIntent ? normalizeJsonArray(raw.testcases).slice(0, 25) : [];
    return {
      reply: this.sanitizeZyraReply(raw.reply, this.defaultZyraReply(message, existingTestcases)),
      reasoningSummary: String(raw.reasoningSummary || this.defaultReasoningSummary(existingTestcases.length)).slice(0, 1500),
      actionType,
      operations: mutationIntent ? operations : [],
      testcases
    };
  }

  // ─── Degraded mode ───────────────────────────────────────────────────────────
  // Everything below runs ONLY when the AI is unreachable: no key allocated, the provider errored,
  // or the response was unusable. It is not a router and never competes with the model for a live
  // request (that ambiguity is what produced the "generated but never saved" bug — a keyword table
  // decided the request meant "answer" and the model's reply was believed). Kept deliberately so
  // an outage degrades to something useful instead of an error string.
  private zyraDegradedDecision(
    message: string,
    existingTestcases: ZyraGenerationInput["existingTestcases"],
    reason: string
  ): ZyraChatDecision {
    const intent = this.detectZyraChatIntent(message);
    const note = `⚠️ Zyra's AI provider is unavailable right now (${reason}), so this is a best-effort answer from the test repository only — no test cases were generated or changed.`;
    // Generation genuinely cannot happen without the provider — say so rather than pretending.
    if (intent === "create" || intent === "update" || intent === "archive" || intent === "suite") {
      return {
        reply: `${note}\n\nI can't ${intent === "create" ? "generate test cases" : "change the test repository"} until the provider is reachable. Check Settings → AI Providers, then ask me again.`,
        reasoningSummary: `Degraded mode (${reason}). Refused a ${intent} request rather than mutating the repository without AI context.`,
        actionType: "answer",
        operations: [],
        testcases: []
      };
    }
    // Read-only requests can still be served from the repository snapshot, as a table.
    if (intent === "list" && existingTestcases.length) {
      return {
        reply: `${note}\n\nHere is the nearest existing coverage I could match.`,
        reasoningSummary: `Degraded mode (${reason}). Listed ${existingTestcases.length} existing testcase(s) from repository context.`,
        actionType: "answer",
        operations: [],
        testcases: existingTestcases.slice(0, 25).map((tc) => this.chatDraftRow(tc, "covered", "Existing coverage matched without AI."))
      };
    }
    return {
      reply: `${note}\n\n${this.defaultZyraReply(message, existingTestcases)}`,
      reasoningSummary: `Degraded mode (${reason}). ${this.defaultReasoningSummary(existingTestcases.length)}`,
      actionType: "answer",
      operations: [],
      testcases: []
    };
  }

  // Keyword intent detection. NOT the router — the AI decides live requests (see
  // buildZyraChatDecision). This only shapes the degraded reply above, which is why the verb stems
  // matter less here, but they are kept correct anyway.
  private detectZyraChatIntent(message: string): ZyraChatIntent {
    const lower = message.toLowerCase();
    const jiraWords = /\b(jira|ticket|tickets|story|stories|issue|issues)\b/.test(lower);
    const testcaseWords = /\b(testcase|test case|testcases|test cases|case|cases|coverage)\b/.test(lower);
    const createWords = /\b(creat|generat|draft|prepar|author)\w*\b|\b(add|adds|added|adding|write|writes|writing|wrote|make|makes|making|new)\b/.test(lower);
    const updateWords = /\b(updat|chang|revis|edit|modif|improv)\w*\b|\b(mark|marks|marked)\b/.test(lower);
    const archiveWords = /\b(remov|delet|archiv|deprecat)\w*\b|\b(drop|drops|dropped)\b/.test(lower);
    const saveWords = /\b(sav(e|es|ed|ing)|stor(e|es|ed|ing)|persist(s|ed|ing)?)\b/.test(lower);
    const listWords = /\b(show|list|which|what|find|display|compare|covered|covers|coverage|existing)\b/.test(lower);
    const exampleWords = /\b(example|sample|explain|how|why|what is|what are|walk me|describe)\b/.test(lower);
    // "folder" alone is ambiguous — a testcase suite in "create a folder" phrasing, a knowledge-base
    // folder in "knowledge base 'X' folder" phrasing.
    const knowledgeBaseWords = /\bknowledge\s*base\b/.test(lower);
    const suiteWords = /\b(suite|suites)\b/.test(lower) || (/\b(folder|folders)\b/.test(lower) && !knowledgeBaseWords);
    const moveWords = /\b(move|moved|moving|assign|assigned|organi[sz]e|organi[sz]ed|group|grouped|regroup|categori[sz]e|reorgani[sz]e)\b/.test(lower);
    const analysisWords = /\b(review|analyse|analyze|gap|gaps|let me know|tell me|identify|what to|which to|what we need|which we need|what cases|which cases)\b/.test(lower);

    if (saveWords && !updateWords && !archiveWords) return "create";
    if (suiteWords || (moveWords && testcaseWords)) return "suite";
    if (archiveWords && testcaseWords) return "archive";
    if (updateWords && testcaseWords) return "update";
    if (createWords && testcaseWords && analysisWords) return "list";
    if (createWords && testcaseWords) return "create";
    if (testcaseWords && listWords) return "list";
    if (exampleWords) return "example";
    return "answer";
  }

  // The conversation as the model should see it, with every assistant turn annotated by what it
  // ACTUALLY wrote to the repository. This is the fact that makes "save it" resolvable: a reply
  // enumerating 15 test cases and a reply that saved 15 test cases read identically as prose, and
  // the model cannot tell them apart from its own words — so it is told. Persisted rows carry an
  // id (chatTestcaseRow); rows that were only suggested do not (chatDraftRow).
  private zyraTranscript(history: Body[]): string {
    if (!history.length) return "No prior chat.";
    return history.map((row) => {
      let content = String(row?.content || "");
      const trimmed = content.trim();
      if (trimmed.startsWith("{")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (typeof parsed?.reply === "string" && parsed.reply) content = parsed.reply;
        } catch { /* not JSON — use as-is */ }
      }
      if (String(row?.role) !== "assistant") return `user: ${content}`;
      const rows = normalizeJsonArray(row?.testcases);
      const saved = rows.filter((item) => item && (item as Body).id);
      const externalIds = saved.map((item) => String((item as Body).externalId || "")).filter(Boolean);
      /*
       * The annotation says what the turn PERSISTED. Basecamp 10231190735 and 10231274688 showed
       * what it was missing: whether the turn was still waiting on the user.
       *
       * A turn that proposed an archive ("Should I archive PRO-TC-124? Reply yes to confirm") saves
       * nothing, so it was annotated "[saved nothing — any testcases named in this reply do not
       * exist in the repository]" — and the very next instruction tells the model to trust the
       * annotations over its own earlier wording. So when the user replied "yes", the one fact
       * needed to resolve it had been described as something not to rely on, the turn routed to
       * `answer`, and nothing was archived while the reply said it had been.
       *
       * Naming the action type the turn was routed as gives the confirmation an antecedent. It is a
       * fact we already store (zyra_chat_messages.action_type) rather than another rule in the
       * prompt, and it is the model — not a keyword matcher — that decides what "yes" refers to.
       */
      const actionType = String(row?.action_type || row?.actionType || "").trim();
      const proposal =
        !saved.length && (actionType === "create" || actionType === "archive" || actionType === "update")
          ? ` [this turn was routed as '${actionType}' but wrote nothing — treat it as a PROPOSAL still awaiting the user's go-ahead; if their next message confirms it, carry it out now]`
          : "";
      /*
       * The proposal annotation above only fires for a turn routed create/archive/update — but a gap
       * analysis routes `answer` (correctly: it changed nothing) and can still end in an offer —
       * "Would you like me to generate test cases for these gaps?" — that the very next "yes" is
       * meant to confirm. That routing decision has no antecedent flag at all today, unlike the
       * create/archive/update case, so it depends entirely on the model re-reading this turn's prose
       * — which the prompt already asks it to do (see the "confirmation of an offer" rule), but with
       * no structural nudge behind it the way the proposal annotation gives the other three action
       * types. This gives it the same nudge, without a keyword router deciding what the confirmation
       * means — that stays the model's call.
       */
      const offer = !saved.length && !proposal && LegacyService.ZYRA_OFFER_PATTERN.test(content)
        ? " [this turn ended with an offer to act — if the user's next message confirms it (yes, go ahead, please do, do it), work out what was offered and carry it out now]"
        : "";
      const note = saved.length
        ? `[saved ${saved.length} testcase(s) to the repository${externalIds.length ? `: ${externalIds.join(", ")}` : ""}]`
        : "[saved nothing — any testcases named in this reply do not exist in the repository]";
      return `assistant ${note}${proposal}${offer}: ${content}`;
    }).join("\n");
  }

  // Deliberately narrow: an offer phrase immediately followed by an action verb and a question mark
  // within a short window, not "any sentence with a question mark" (which would flag ordinary
  // clarifying questions like "which module should this cover?" as something to auto-confirm).
  private static readonly ZYRA_OFFER_PATTERN =
    /\b(would you like me to|do you want me to|want me to|should i|shall i)\b[^.!?\n]{0,120}\b(generat|creat|add|writ|draft|archiv|remov|delet|updat|chang|mov|assign|organi[sz]e)\w*\b[^.!?\n]{0,120}\?/i;

  // Resolve the router's suite against reality: an id only counts if the suite exists, a name is
  // matched case-insensitively to an existing suite, and a genuinely new name is passed through to
  // be created on demand.
  private resolveRoutedZyraSuite(
    routed: { id?: string; name?: string } | null | undefined,
    suites: Array<{ id: string; name: string }>
  ): { id?: string; name: string } | null {
    if (!routed) return null;
    const byId = routed.id ? suites.find((suite) => suite.id === routed.id) : undefined;
    if (byId) return { id: byId.id, name: byId.name };
    const name = String(routed.name || "").trim();
    if (!name) return null;
    const byName = suites.find((suite) => suite.name.trim().toLowerCase() === name.toLowerCase());
    return byName ? { id: byName.id, name: byName.name } : { name };
  }

  // The suite the router named for a create request, read off whichever operation carries one. An
  // id it invented is dropped rather than trusted (see resolveRoutedZyraSuite); a name it invented
  // is fine, because suites are created by name on demand.
  private routedZyraSuite(raw: Body, suites: Array<{ id: string; name: string }>): { id?: string; name?: string } | null {
    const op = normalizeJsonArray(raw?.operations).find((candidate) => {
      const type = String((candidate as Body)?.type || "");
      return (type === "create" || type === "move_to_suite" || type === "create_suite")
        && ((candidate as Body)?.suiteId || (candidate as Body)?.suiteName);
    }) as Body | undefined;
    if (!op) return null;
    const suiteId = op.suiteId ? String(op.suiteId).trim() : "";
    const matchedById = suiteId ? suites.find((suite) => suite.id === suiteId) : undefined;
    if (matchedById) return { id: matchedById.id, name: matchedById.name };
    const suiteName = op.suiteName ? String(op.suiteName).trim().slice(0, 128) : "";
    return suiteName ? { name: suiteName } : null;
  }

  private normalizeZyraCapabilities(raw: unknown): ZyraCapabilities {
    const caps = (raw && typeof raw === "object" ? raw : {}) as Body;
    return {
      generation: caps.generation !== false,
      knowledgeBase: caps.knowledgeBase !== false,
      testcaseStorage: caps.testcaseStorage !== false,
      suiteOperations: caps.suiteOperations !== false
    };
  }

  private async zyraAgentSettings(projectId: string): Promise<Body> {
    const project = await this.getProject(projectId).catch(() => ({} as Body));
    return (this.parseProjectSettings((project as Body).settings).zyraAgent || {}) as Body;
  }

  private async zyraProjectCapabilities(projectId: string): Promise<ZyraCapabilities> {
    const zyraAgent = await this.zyraAgentSettings(projectId);
    return this.normalizeZyraCapabilities(zyraAgent.capabilities);
  }

  private zyraCapabilityDisabled(capability: keyof ZyraCapabilities, existingCount: number): ZyraChatDecision {
    const label: Record<keyof ZyraCapabilities, string> = {
      generation: "Test case generation",
      knowledgeBase: "Knowledge base access",
      testcaseStorage: "Test case storage operations (create, update, delete, bulk)",
      suiteOperations: "Suite operations (create, move/assign)"
    };
    const reason = `${label[capability]} is currently disabled for Zyra in this project. Enable it under Zyra → Settings → Capabilities, then try again.`;
    return {
      reply: reason,
      reasoningSummary: `Requested a disabled Zyra capability (${capability}). ${existingCount} nearby testcase(s) available for context.`,
      actionType: "answer",
      operations: [],
      testcases: []
    };
  }

  // Generation is allowed but storage is OFF: keep the generated drafts as suggestions, persist nothing.
  private applyStorageGateToGenerated(decision: ZyraChatDecision, capabilities: ZyraCapabilities): ZyraChatDecision {
    if (capabilities.testcaseStorage) return decision;
    return {
      ...decision,
      operations: [],
      actionType: "answer",
      reply: `Test case storage is disabled for Zyra in this project, so these are suggestions only — I did not save them. Enable "Test case storage operations" under Zyra → Settings → Capabilities to let me save generated testcases.\n\n${decision.reply}`
    };
  }

  // Test cases belong in the structured rows the UI renders as a table — never in the chat bubble as
  // markdown. A model that writes the table into `reply` produces cases the user can read but cannot
  // open, run, or edit; in the reported session that markdown table WAS the entire deliverable and
  // none of it existed in the repository. Tables that are not testcase listings (coverage summaries,
  // Jira comparisons) are legitimate prose and are left untouched.
  private stripZyraTestcaseTables(reply: string, hasRows: boolean): string {
    const lines = reply.split("\n");
    const kept: string[] = [];
    let removed = false;
    for (let i = 0; i < lines.length; ) {
      if (!lines[i].trim().startsWith("|")) {
        kept.push(lines[i]);
        i += 1;
        continue;
      }
      let end = i;
      while (end < lines.length && lines[end].trim().startsWith("|")) end += 1;
      const block = lines.slice(i, end);
      if (this.isZyraTestcaseTable(block)) {
        removed = true;
      } else {
        kept.push(...block);
      }
      i = end;
    }
    if (!removed) return reply;
    const cleaned = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (hasRows) return cleaned;
    // Nothing was saved and the only record of those cases was the markdown just removed — say what
    // happened and how to actually get them, rather than leaving a table that implies they exist.
    return [
      cleaned,
      "",
      "_Those test cases were only described in chat — they were not saved to the repository. Ask me to generate them and they'll be created and shown in the table above._"
    ].join("\n").trim();
  }

  private isZyraTestcaseTable(block: string[]): boolean {
    if (block.length < 2) return false;
    // A markdown table needs its separator row (|---|---|) within the first two lines.
    if (!block.slice(0, 2).some((line) => /^\s*\|[\s:|-]+\|\s*$/.test(line))) return false;
    const header = block[0].split("|").map((cell) => cell.trim().toLowerCase()).filter(Boolean);
    // Only a column that DEFINES new test content — a title/scenario to run, steps to follow, an
    // expected outcome, a pre/postcondition — is evidence a table is authoring test cases. "Test
    // Case(s)" is not: a coverage table cites existing cases by id under exactly that header ("Area
    // | Test Cases" -> "TTM-TC-1"), so treating it as an anchor misfired on coverage answers, a
    // per-module breakdown, and a Jira-to-testcase comparison alike — all reference existing rows,
    // none define new ones. Reference-only columns (priority/status/area/id/"test case" itself) stay
    // in the secondary count below since authored tables carry them too, but none alone is authorship.
    const anchors = ["title", "scenario", "steps", "step", "expected", "precondition", "preconditions", "postcondition", "postconditions"];
    const columns = [...anchors, "priority", "severity", "type", "status", "area", "module", "id", "#", "test case", "testcase"];
    const hasAnchor = header.some((cell) => anchors.some((anchor) => cell.includes(anchor)));
    const matches = header.filter((cell) => columns.some((column) => cell.includes(column))).length;
    return hasAnchor && matches >= 2;
  }

  // Everything a reply must satisfy before the user sees it: test cases live only in the table, and
  // no claim of a mutation survives that the system did not actually perform.
  private finalizeZyraChatReply(decision: ZyraChatDecision, applied: ZyraAppliedOperations, renderedRows: Body[]): string {
    const reconciled = this.reconcileZyraReply(decision, applied);
    return this.stripZyraTestcaseTables(reconciled, renderedRows.length > 0);
  }

  // The reply is written by the model (or by the generator) BEFORE the operations are applied, and
  // nothing used to compare the two — so a decision that promised a mutation and then persisted
  // nothing was still reported as a success ("All 15 test cases have been saved into the Login
  // suite" over zero written rows). Prefix an honest correction rather than let the claim stand.
  /*
   * Keeps the visible reply honest about what was actually written.
   *
   * `decision.reply` is model-authored prose. It states what the model INTENDED, and the model does
   * not write — applyZyraChatOperations does, and it drops operations for several reasons: the
   * ZYRA_CHAT_MAX_OPERATIONS per-message cap, an external-id conflict that survives one retry, a
   * referenced test case or suite that does not exist, and capability gating.
   *
   * This used to correct only the all-or-nothing case (`if (applied.testcases.length) return
   * decision.reply`), so a turn that asked for 20 and applied 7 returned "Created 20 edge case test
   * scenarios..." verbatim while 7 existed — Basecamp 10212827246 ("shows success but test cases are
   * not reflected") and the "Created 20..." / "7 test cases generated" mismatch on 10212918496.
   * A partial application is now reported as a partial application, with applied.activity carrying
   * the per-operation reason.
   */
  /*
   * Failure, in the user's terms.
   *
   * The provider detail ("AI testcase generation returned invalid JSON", "429 Too Many Requests") is
   * what a developer needs and what a person asking for test cases cannot act on. It stays in
   * reasoningSummary and the activity log; this maps it to a cause and, more usefully, to the thing
   * the user can actually do about it.
   */
  /*
   * When the knowledge base has nothing to say about what was asked for.
   *
   * Basecamp 10231923903 asked for "passwordless biometric login" in a project whose knowledge base
   * has no such feature. Refusing outright is unhelpful — generic cases for a well-understood flow
   * are a real starting point — and generating silently is worse, because the reply's "after reading
   * N knowledge-base item(s)" line then implies the cases came from the team's own requirements when
   * they came from the model's general knowledge.
   *
   * So: say it plainly, hand over the generic cases anyway, and name the one thing that would make
   * them specific. The cases are still written to the repository, as every other create is — Zyra has
   * no draft state, and a case the user can read but not open or run is its own bug (2026-07-31).
   */
  /*
   * Drafts, not "created".
   *
   * Zyra's generations are written with status Draft (they always were), but the reply called them
   * created and they landed with no suite — so "created" was doing two jobs at once: the row exists,
   * and the work is done. Only the first was true. The wording says drafted, names where they are
   * staged, and says how to file them, so the state on screen and the state in the sentence agree.
   */
  private static zyraDraftFilingHint(suiteName: string | null): string {
    return suiteName === LegacyService.ZYRA_DRAFT_SUITE_NAME
      ? `They're staged as drafts in **${LegacyService.ZYRA_DRAFT_SUITE_NAME}** — say "save them to <suite>" and I'll file them where they belong.`
      : `They're drafts in **${suiteName}** — review them there, or say "save them to <suite>" to move them.`;
  }

  private static zyraUngroundedNote(count: number): string {
    return [
      "ℹ️ I don't have anything about this in the project's knowledge base, and no Jira ticket matched it either.",
      "",
      `I've still written ${count} test case(s) from general practice for this kind of feature, so you have somewhere to start — treat them as a draft to review rather than as coverage of your actual behaviour.`,
      "",
      "Add the requirement, spec or acceptance criteria to the knowledge base (or link the Jira ticket) and ask me again — I'll regenerate them against how your feature really works, with your own terminology and edge cases."
    ].join("\n");
  }

  /*
   * Where Zyra's own generations land when the request named no suite.
   *
   * Chat creates used to be written with suite_id NULL, so they fell into the repository's "No
   * suite" bucket alongside anything else that had never been filed — indistinguishable from a case
   * someone created by hand and forgot to sort. They are drafts produced by an agent, and they need
   * somewhere identifiable to sit until a person decides where they belong.
   *
   * A named suite still wins: "generate 10 for Login" puts them in Login, as it always has. This is
   * only the default for a request that named nowhere.
   */
  static readonly ZYRA_DRAFT_SUITE_NAME = "Zyra generated test cases";

  /** The narrowed second attempt's batch size — small enough that a truncated response is unlikely. */
  private static readonly ZYRA_RETRY_BATCH = 5;

  /*
   * Every outbound fetch() to an AI provider used to carry no timeout at all — not here, not in the
   * frontend's api() helper, not at the nginx layer (24h). A provider that stalls (a half-open TCP
   * connection, a silent overload with no error) left the request open indefinitely: no reply, no
   * error banner, the chat's "thinking" spinner running forever. That is indistinguishable from
   * "Zyra doesn't respond" as reported, and it is the one failure mode nothing else in this file
   * already turns into a visible outcome — every other path (a 4xx/5xx, malformed JSON, a thrown
   * exception) is already caught somewhere and answered with a message.
   *
   * These are deliberately generous, not a snappy request timeout — cutting a call short at 5-10s
   * would abort completions that were genuinely still working and turn "slow but fine" into "failed
   * for no reason", which is worse than the silence it replaces. The router is a small JSON envelope
   * and normally answers in single-digit seconds; the generation call can legitimately run to a
   * minute or more for a large batch (max_tokens scales up to 16000 — see generateZyraWithAnthropic).
   * Both budgets sit well above realistic completion time and still bound the worst case to minutes,
   * not forever.
   *
   * A timeout is NOT treated as just another provider error. buildZyraChatDecision hands it a
   * ZyraResumeCheckpoint instead of a failure reply, so the turn can be picked back up (see
   * continueZyraChatMessage) rather than forcing the user to re-ask and pay for the whole context
   * again.
   */
  private static readonly ZYRA_ROUTER_TIMEOUT_MS = 60_000;
  private static readonly ZYRA_GENERATE_TIMEOUT_MS = 180_000;

  /** A fresh per-attempt budget — a model-candidate fallback loop must not have an earlier candidate's stall eat into the next one's time. */
  private static zyraProviderSignal(ms: number): AbortSignal {
    return AbortSignal.timeout(ms);
  }

  // AbortSignal.timeout() rejects fetch with a DOMException named "TimeoutError"; a caller-driven
  // AbortController (not used here today, kept for completeness) would surface "AbortError" instead.
  // Never true for a rejection that came from the provider itself (a 4xx/5xx, malformed JSON) — those
  // already carry their own message and go through the normal failure path.
  private isZyraTimeoutError(err: unknown): boolean {
    return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
  }

  private static zyraFailureCause(detail: string): { cause: string; advice: string } {
    const text = String(detail || "").toLowerCase();
    if (/json|parse|truncat|unterminated|unexpected token|no testcase drafts|no drafts/.test(text)) {
      return {
        cause: "the AI's answer came back incomplete, so I couldn't read the test cases out of it",
        advice: "asking for fewer cases at a time usually fixes this — try \"generate 5\" and I'll build on it"
      };
    }
    if (/rate.?limit|429|quota|too many requests/.test(text)) {
      return {
        cause: "the AI provider is rate-limiting this workspace right now",
        advice: "wait a minute and ask again — nothing about your request was wrong"
      };
    }
    if (/api key|unauthor|401|403|invalid.*key|revoked/.test(text)) {
      return {
        cause: "the AI provider rejected the workspace's key",
        advice: "an admin can check the key in Settings → AI providers; I can't generate anything until that's sorted"
      };
    }
    if (/timeout|timed out|econnreset|network|fetch failed|socket/.test(text)) {
      return {
        cause: "the AI provider didn't answer in time",
        advice: "try again — if it keeps timing out, a smaller request gets through more reliably"
      };
    }
    if (/no provider|not configured|missing/.test(text)) {
      return {
        cause: "no AI provider is configured for this workspace",
        advice: "an admin can connect one in Settings → AI providers"
      };
    }
    return {
      cause: "the AI provider returned an error",
      advice: "try again, or narrow the request to fewer cases"
    };
  }

  /** What the turn set out to do, so a failure can say what it was attempting rather than just that it failed. */
  private static zyraAttemptSummary(input: {
    requestedCount?: number | null;
    knowledgeCount: number;
    jiraCount: number;
    suiteName?: string | null;
  }): string {
    const target = input.requestedCount && input.requestedCount > 0 ? `${input.requestedCount} test case(s)` : "test cases";
    const sources = [
      input.knowledgeCount ? `${input.knowledgeCount} knowledge-base item(s)` : null,
      input.jiraCount ? `${input.jiraCount} Jira ticket(s)` : null
    ].filter(Boolean);
    return [
      `generate ${target}`,
      input.suiteName ? `for the "${input.suiteName}" suite` : null,
      sources.length ? `from ${sources.join(" and ")}` : "from your request alone, with nothing matching in the knowledge base"
    ].filter(Boolean).join(" ");
  }

  /*
   * The graceful failure reply.
   *
   * Asked for directly: say what I tried, say what went wrong, say what you can do — instead of a
   * bare error, and instead of prose that reads as though something was produced.
   */
  private static zyraFailureReply(attempt: string, detail: string, retried: boolean): string {
    const { cause, advice } = LegacyService.zyraFailureCause(detail);
    return [
      "⚠️ I ran into a problem and couldn't finish this — **nothing was created or saved.**",
      "",
      `**What I tried:** to ${attempt}.` + (retried ? " When that failed I retried with a smaller batch, and that didn't get through either." : ""),
      `**What went wrong:** ${cause}.`,
      `**What you can do:** ${advice}.`
    ].join("\n");
  }

  /*
   * Completion language, for the answer-turn guard below. Past tense only, and only about the
   * repository: "I'll create…" and "shall I archive…" are proposals and must survive untouched,
   * while "Created 7 test cases", "PRO-TC-124 has been archived" and "saved them to the Login suite"
   * are claims about work this turn did not do.
   *
   * This is a check on OUTPUT, not on comprehension — the router's reading of the user is the model's
   * job and stays the model's job. This only decides whether a reply that already exists is allowed
   * to say a mutation happened.
   */
  private static readonly ZYRA_COMPLETION_CLAIM =
    /\b(created|added|generated(\s+and\s+saved)?|saved|archived|updated|deleted|removed|moved|staged|drafted|proposed)\b[^.!?\n]{0,80}\b(test\s?cases?|tc-\d|suite|repository)\b|\b(test\s?cases?|suite)\b[^.!?\n]{0,80}\b(have|has|were|was)\s+been\s+(created|added|generated|saved|archived|updated|removed|moved|staged|drafted|proposed)\b/i;

  // A reply that already admits nothing happened — "Nothing was saved", "No test cases were
  // created", "could not create/save" — must not be wrapped a second time; the completion-claim
  // guard below exists to add an honest correction, not to stack one on top of an honest refusal.
  private static readonly ZYRA_ALREADY_DISCLOSED =
    /\b(nothing was (saved|changed|created|written)|no\s+test\s?cases?\s+(were|was)\s+(created|saved|added)|could\s+not\s+(create|save|generate|archive|update|add)|generation\s+is\s+(turned\s+off|disabled|off))\b/i;

  // Deterministic per-suite footer built from applied.moveBreakdown (ground truth read back from the
  // database in zyraMoveBreakdown), appended to every reconcileZyraReply return path. The model's own
  // prose is never parsed or rewritten to check its counts — that's unreliable free-text matching —
  // this just states the real numbers underneath, the same "banner alongside the model's words rather
  // than editing them" pattern the rest of this function already uses.
  private zyraMoveBreakdownSuffix(moveBreakdown: Array<{ suiteId: string; suiteName: string; created: boolean; count: number }> | undefined): string {
    if (!moveBreakdown || !moveBreakdown.length) return "";
    const total = moveBreakdown.reduce((sum, entry) => sum + entry.count, 0);
    const parts = moveBreakdown.map((entry) => {
      const label = entry.created ? `${entry.suiteName} (created)` : entry.suiteName;
      return entry.count > 0 ? `${label}: ${entry.count}` : `${label}: 0 (none matched)`;
    });
    return `\n\n📦 **Moved to suites (actual):** ${parts.join(" · ")} — ${total} test case(s) total.`;
  }

  private reconcileZyraReply(decision: ZyraChatDecision, applied: ZyraAppliedOperations): string {
    const moveSuffix = this.zyraMoveBreakdownSuffix(applied.moveBreakdown);
    /*
     * An `answer` turn used to return its reply unchecked, on the reasoning that an answer changes
     * nothing so there is nothing to reconcile. That is exactly backwards: an answer changes nothing,
     * so a reply that SAYS it changed something is the one case nothing else can catch.
     *
     * Three cards, one shape (Basecamp 10231190735, 10231274688, 10231923903): the user replies "yes"
     * to a proposed archive, or asks again in a session where an earlier turn really did create
     * cases, the turn routes to `answer`, and the model's prose reports the work as done. On
     * 10231190735 the user then asked "is it created?" and Zyra — reading the same transcript
     * annotations — correctly answered no. It had already told them yes.
     *
     * The correction goes FIRST, before the model's prose, so the two are read in the right order.
     */
    if (decision.actionType === "answer") {
      if (
        !applied.testcases.length &&
        LegacyService.ZYRA_COMPLETION_CLAIM.test(decision.reply) &&
        !LegacyService.ZYRA_ALREADY_DISCLOSED.test(decision.reply)
      ) {
        return [
          "⚠️ **Sorry! Nothing was saved.** Anything described below as created, saved or archived was not carried out — I only described it.",
          "",
          "Ask me to go ahead and I'll make the change and show you the affected test cases.",
          "",
          decision.reply
        ].join("\n") + moveSuffix;
      }
      return decision.reply + moveSuffix;
    }
    // Creating an empty suite touches no testcases and is still a complete success.
    if (decision.operations.length && decision.operations.every((op) => op.type === "create_suite")) return decision.reply + moveSuffix;

    // create_suite is the one operation that is not expected to produce a testcase row.
    const requested = decision.operations.filter((op) => op.type !== "create_suite").length;
    const appliedCount = applied.testcases.length;

    if (!appliedCount) {
      const detail = decision.operations.length
        ? "The test cases it referred to do not exist in this project, so there was nothing to change."
        : "I did not produce any test case operations for this request.";
      return [
        `⚠️ Nothing was saved. ${detail} Ask me to generate the test cases and I'll draft them for review in the same step.`,
        "",
        decision.reply
      ].join("\n") + moveSuffix;
    }

    // create/update/archive no longer write straight to the repository — they're staged for review
    // (see applyZyraChatOperations), so a reply claiming "created"/"saved"/"archived" past tense is
    // no longer accurate even when every requested operation produced a row. Appended after the
    // model's own prose rather than replacing it, so the reply keeps whatever specifics it named.
    const proposedCount = applied.testcases.filter((tc) => typeof tc.action === "string" && tc.action.startsWith("proposed-")).length;
    const reviewHint = proposedCount > 0
      ? `\n\n📝 ${proposedCount} of them ${proposedCount === 1 ? "is" : "are"} staged for your review — open the review panel to select, edit, or discard, then Save to add ${proposedCount === 1 ? "it" : "them"} to the repository. Nothing has been written to the repository yet.`
      : "";

    if (appliedCount < requested) {
      // The reasons are already in the activity log this turn; naming them here keeps the chat itself
      // truthful instead of making the user open the activity panel to find out.
      const reasons = applied.activity
        .filter((entry) => /could not|skipped/i.test(String(entry.title || "")))
        .map((entry) => String(entry.detail || entry.title))
        .filter(Boolean);
      return [
        `⚠️ ${appliedCount} of ${requested} test case operation(s) were drafted for review.` +
          (reasons.length ? ` ${reasons.join(" ")}` : " The rest were not drafted."),
        "",
        decision.reply + reviewHint
      ].join("\n") + moveSuffix;
    }

    return decision.reply + reviewHint + moveSuffix;
  }

  private aiUnavailableForZyraChat(existingCount: number, reason = "AI generation was not available for this chat request."): ZyraChatDecision {
    return {
      reply: reason,
      reasoningSummary: `Zyra could not complete an AI response. ${existingCount} nearby testcase(s) were available for context. Detail: ${reason}`,
      actionType: "answer",
      operations: [],
      testcases: []
    };
  }

  private extractJiraIssueKeys(message: string): string[] {
    const keys = new Set<string>();
    // Hyphenated form stays case-insensitive: people do type "ead-11215" for EAD-11215.
    for (const match of message.match(/\b[A-Z][A-Z0-9]+-\d+\b/gi) || []) {
      keys.add(match.toUpperCase());
    }
    /*
     * Space-separated form ("EAD 11215"), for a key typed without its hyphen.
     *
     * Deliberately CASE-SENSITIVE. With the /i flag this matched any word followed by a number,
     * so ordinary English turned into Jira keys: "create 10 first" produced CREATE-10, "add 2
     * back" produced ADD-2, "give me 20 smoke tests" produced ME-20. Six of the eight real
     * production messages that hit this pattern invented a ticket that has never existed.
     *
     * The consequences were not cosmetic. Each phantom key was reported to the user as a source
     * Zyra had "read directly", and — because jiraSnapshot live-fetches any key missing from the
     * sync cache — each one also fired a real Jira API request for a nonexistent issue on every
     * message. A stopword list cannot fix this: the space-separated form is inherently ambiguous
     * with "<verb> <count>", which is how users ask for test cases. Requiring the uppercase a
     * real project key actually has is what disambiguates it, and resolveJiraIssueKeys() below
     * then checks the prefix against the project's configured Jira projects.
     */
    const loosePattern = /\b([A-Z][A-Z0-9]{1,9})\s+(\d+)\b/g;
    let loose: RegExpExecArray | null;
    while ((loose = loosePattern.exec(message))) {
      const prefix = loose[1].toUpperCase();
      if (["THE", "FOR", "AND", "WITH", "FROM", "THIS", "THAT", "CASE", "TEST"].includes(prefix)) continue;
      keys.add(`${prefix}-${loose[2]}`);
    }
    return Array.from(keys);
  }

  /**
   * Issue keys in a message that could plausibly belong to THIS project's Jira.
   *
   * Pattern-matching alone cannot tell a real key from a coincidence — "TEST-1" is a valid key
   * shape and also something a person writes by accident. The project's configured Jira projects
   * (jira_project_mappings) are the only authority on which prefixes exist, so a key whose prefix
   * is not configured is dropped before it can be looked up, live-fetched, or reported to the user
   * as a source that was read.
   *
   * A project with no Jira mapping therefore resolves nothing, which is the correct answer: it has
   * no Jira to have read from.
   */
  private async resolveJiraIssueKeys(projectId: string, message: string): Promise<string[]> {
    return (await this.resolveJiraIssueKeysDetailed(projectId, message)).keys;
  }

  /**
   * Same resolution, but reports what was discarded and why — the shape the trace records.
   * `extracted` minus `keys` is exactly the phantom-key population, so a span showing
   * extracted:[CREATE-10] / validated:[] is the bug being prevented, visible without a DB audit.
   */
  private async resolveJiraIssueKeysDetailed(
    projectId: string,
    message: string
  ): Promise<{ keys: string[]; extracted: string[]; configuredProjectKeys: string[] }> {
    const candidates = this.extractJiraIssueKeys(message);
    // The overwhelmingly common case is a message with no key-shaped text at all. Returning before
    // touching the database keeps this free for those, which matters on a per-message path.
    if (!candidates.length) return { keys: [], extracted: [], configuredProjectKeys: [] };

    const mappings = await this.db
      .query<{ jira_project_key: string }>(
        "SELECT jira_project_key FROM jira_project_mappings WHERE project_id = $1 AND enabled = true",
        [projectId]
      )
      .catch(() => ({ rows: [] as Array<{ jira_project_key: string }> }));
    const configuredProjectKeys = mappings.rows.map((row) => String(row.jira_project_key || "").trim().toUpperCase()).filter(Boolean);
    const configured = new Set(configuredProjectKeys);
    if (!configured.size) return { keys: [], extracted: candidates, configuredProjectKeys };

    const keys = candidates.filter((key) => configured.has(key.slice(0, key.lastIndexOf("-")).toUpperCase()));
    return { keys, extracted: candidates, configuredProjectKeys };
  }

  // Decides how many testcases Zyra chat should generate. An explicit number in the message
  // always wins; otherwise an "all possible" / "exhaustive" style ask in the message maps to
  // the "all" range; otherwise this falls back to whatever range the user configured in
  // Zyra → Settings → Test case range, instead of a fixed small default that ignores it.
  private chatTestcasePlan(
    message: string,
    projectTestcaseRange: string,
    routed?: { requestedCount?: unknown; exhaustive?: boolean }
  ): { requestedCount: number; testcaseRange?: string } {
    // The router read the request in context — "fifteen", "a couple more than last time", "cover
    // everything you can" — so its reading wins. The patterns below only cover the case where it
    // reported nothing.
    if (routed?.exhaustive) return { testcaseRange: "all", requestedCount: this.testcaseRangeConfig("all").requestedCount };
    const routedCount = Number(routed?.requestedCount);
    if (Number.isFinite(routedCount) && routedCount >= 1) return { requestedCount: Math.min(25, Math.floor(routedCount)) };
    const explicit = message.match(/\b(\d{1,2})\s+(?:testcases|test cases|tests|cases)\b/i);
    if (explicit) return { requestedCount: Math.max(1, Math.min(25, Number(explicit[1]))) };
    const lower = message.toLowerCase();
    const wantsExhaustive = /\ball( the)? possible\b|as many as possible|\bexhaustive\b|every (scenario|edge case|flow|case)|full coverage|\ball types?\b/.test(lower);
    const range = wantsExhaustive ? "all" : projectTestcaseRange;
    return { testcaseRange: range, requestedCount: this.testcaseRangeConfig(range).requestedCount };
  }

  // Routes "all possible cases" through the plan-then-batch flow (startZyraChatPlan) and
  // everything else through the normal single-shot generation — shared by both create-intent
  // branches in buildZyraChatDecision (local intent detection and model-decided intent).
  private async generateZyraChatCreateDecision(params: {
    projectId: string;
    userId: string;
    sessionId: string;
    provider: string;
    model: string;
    key: Body;
    message: string;
    knowledge: Array<{ title: string; content: string }>;
    existingTestcases: ZyraGenerationInput["existingTestcases"];
    jiraIssueKeys: string[];
    projectTestcaseRange: string;
    suites: Array<{ id: string; name: string }>;
    conversation?: string;
    routedSuite?: { id?: string; name?: string } | null;
    routedCount?: { requestedCount?: unknown; exhaustive?: boolean };
    jira?: Array<{ key: string; summary: string; description: string }>;
  }): Promise<ZyraChatDecision> {
    const plan = this.chatTestcasePlan(params.message, params.projectTestcaseRange, params.routedCount);
    if (plan.testcaseRange === "all") {
      return this.startZyraChatPlan({
        projectId: params.projectId,
        userId: params.userId,
        sessionId: params.sessionId,
        provider: params.provider,
        model: params.model,
        key: params.key,
        message: params.message,
        knowledge: params.knowledge,
        existingTestcases: params.existingTestcases,
        jiraIssueKeys: params.jiraIssueKeys,
        suites: params.suites,
        conversation: params.conversation,
        routedSuite: params.routedSuite,
        jira: params.jira
      });
    }
    return this.generateZyraChatTestcasesWithAi({
      projectId: params.projectId,
      userId: params.userId,
      provider: params.provider,
      model: params.model,
      key: params.key,
      message: params.message,
      knowledge: params.knowledge,
      existingTestcases: params.existingTestcases,
      jiraIssueKeys: params.jiraIssueKeys,
      suites: params.suites,
      conversation: params.conversation,
      routedSuite: params.routedSuite,
      jira: params.jira,
      ...plan
    });
  }

  // The router's action IS the routing decision. `actionType` is consulted only when `action` is
  // missing or unrecognized, and an unusable response falls back to "answer" — never to a guess
  // that mutates the repository.
  private intentFromZyraModelAction(action: unknown, actionType?: unknown): ZyraChatIntent {
    for (const candidate of [action, actionType]) {
      const value = String(candidate || "").trim().toLowerCase();
      if (value === "jira_pending_testcases") return "jira_pending_testcases";
      if (value === "suite" || value === "create_suite" || value === "move_to_suite" || value === "list_suites") return "suite";
      if (value === "create" || value === "create_testcases") return "create";
      if (value === "update" || value === "update_testcases") return "update";
      if (value === "archive" || value === "archive_testcases") return "archive";
      if (value === "list" || value === "list_testcases") return "list";
      if (value === "answer") return "answer";
    }
    return "answer";
  }

  private async projectSuiteSummaries(projectId: string): Promise<Array<{ id: string; name: string; testCaseCount: number }>> {
    const suites = await this.db.query(
      `SELECT s.id, s.name, COUNT(t.id)::int AS test_case_count
       FROM suites s LEFT JOIN testcases t ON t.suite_id = s.id AND t.deleted_at IS NULL
       WHERE s.project_id = $1
       GROUP BY s.id, s.name
       ORDER BY s.position, s.name
       LIMIT 50`,
      [projectId]
    ).catch(() => ({ rows: [] as Body[] }));
    return suites.rows.map((row) => ({ id: String(row.id), name: String(row.name || ""), testCaseCount: Number(row.test_case_count || 0) }));
  }

  // Lightweight, deterministic suite-name detection for messages that name an existing suite
  // (e.g. "generate test cases for the Authentication, Signup & Onboarding suite") — used so
  // newly-created testcases can be attached to that suite in the same step, without depending
  // on the model to separately emit a move_to_suite operation. Longest name wins so a short
  // suite name doesn't shadow a longer one that also matches.
  private matchZyraSuiteByName(message: string, suites: Array<{ id: string; name: string }>): { id: string; name: string } | null {
    const lower = message.toLowerCase();
    const candidates = suites.filter((suite) => suite.name.trim() && lower.includes(suite.name.trim().toLowerCase()));
    if (!candidates.length) return null;
    return candidates.reduce((longest, current) => (current.name.length > longest.name.length ? current : longest));
  }

  private async zyraChatProjectSnapshot(projectId: string): Promise<ZyraChatProjectSnapshot> {
    const [knowledge, files, suites, testcases, jira, pending, status] = await Promise.all([
      this.db.query(
        `SELECT title
         FROM knowledge_documents
         WHERE project_id = $1 AND is_deleted = false AND (document_type != 'ai_memory' OR status = 'approved')
         ORDER BY updated_at DESC
         LIMIT 12`,
        [projectId]
      ).catch(() => ({ rows: [] as Body[] })),
      this.db.query(
        `SELECT original_file_name
         FROM knowledge_files
         WHERE project_id = $1 AND is_deleted = false
         ORDER BY updated_at DESC
         LIMIT 12`,
        [projectId]
      ).catch(() => ({ rows: [] as Body[] })),
      this.projectSuiteSummaries(projectId),
      this.db.query(
        `SELECT
           COUNT(*)::int AS testcase_count,
           COUNT(*) FILTER (WHERE jira_issue_key IS NOT NULL AND COALESCE(status, '') <> 'Archived')::int AS linked_jira_testcase_count
         FROM testcases
         WHERE project_id = $1 AND deleted_at IS NULL`,
        [projectId]
      ).catch(() => ({ rows: [{}] as Body[] })),
      this.db.query(
        `SELECT COUNT(*)::int AS jira_ticket_count, MAX(synced_at) AS last_jira_sync_at
         FROM jira_tickets
         WHERE project_id = $1`,
        [projectId]
      ).catch(() => ({ rows: [{}] as Body[] })),
      this.db.query(
        `WITH linked AS (
           SELECT jira_issue_key
           FROM testcases
           WHERE project_id = $1
             AND jira_issue_key IS NOT NULL
             AND COALESCE(status, '') <> 'Archived'
           GROUP BY jira_issue_key
         )
         SELECT COUNT(j.id)::int AS pending_jira_ticket_count
         FROM jira_tickets j
         LEFT JOIN linked l ON l.jira_issue_key = j.jira_issue_key
         WHERE j.project_id = $1 AND l.jira_issue_key IS NULL`,
        [projectId]
      ).catch(() => ({ rows: [{}] as Body[] })),
      this.jiraStatusForProject(projectId).catch(() => ({ connected: false, connectedProjects: [] }))
    ]);
    return {
      knowledgeCount: knowledge.rows.length + files.rows.length,
      knowledgeTitles: [
        ...knowledge.rows.map((row) => String(row.title || "")),
        ...files.rows.map((row) => String(row.original_file_name || ""))
      ].filter(Boolean),
      suites,
      testcaseCount: Number(testcases.rows[0]?.testcase_count || 0),
      // suites only sums testcases with a suite_id (see projectSuiteSummaries' JOIN), so testcases
      // sitting outside any suite are otherwise invisible to the model — it would see a total that
      // doesn't match the sum of the per-suite breakdown, with no explanation for the gap.
      unassignedTestCaseCount: Math.max(0, Number(testcases.rows[0]?.testcase_count || 0) - suites.reduce((sum, suite) => sum + suite.testCaseCount, 0)),
      linkedJiraTestcaseCount: Number(testcases.rows[0]?.linked_jira_testcase_count || 0),
      jiraConnected: Boolean((status as Body).connected),
      jiraProjectCount: normalizeJsonArray((status as Body).connectedProjects).length,
      jiraTicketCount: Number(jira.rows[0]?.jira_ticket_count || 0),
      pendingJiraTicketCount: Number(pending.rows[0]?.pending_jira_ticket_count || 0),
      lastJiraSyncAt: jira.rows[0]?.last_jira_sync_at || null
    };
  }

  private async analyzeZyraJiraTestcaseCoverage(projectId: string): Promise<ZyraChatDecision> {
    const [status, totals, pending] = await Promise.all([
      this.jiraStatusForProject(projectId).catch(() => ({ connected: false, connectedProjects: [] })),
      this.db.query(
        `WITH linked AS (
           SELECT jira_issue_key, COUNT(*)::int AS testcase_count
           FROM testcases
           WHERE project_id = $1
             AND deleted_at IS NULL
             AND jira_issue_key IS NOT NULL
             AND COALESCE(status, '') <> 'Archived'
           GROUP BY jira_issue_key
         )
         SELECT
           COUNT(j.id)::int AS total_tickets,
           COUNT(l.jira_issue_key)::int AS covered_tickets,
           (COUNT(j.id) - COUNT(l.jira_issue_key))::int AS pending_tickets,
           COALESCE(SUM(l.testcase_count), 0)::int AS linked_testcases,
           MAX(j.synced_at) AS last_synced_at
         FROM jira_tickets j
         LEFT JOIN linked l ON l.jira_issue_key = j.jira_issue_key
         WHERE j.project_id = $1`,
        [projectId]
      ),
      this.db.query(
        `WITH linked AS (
           SELECT jira_issue_key, COUNT(*)::int AS testcase_count
           FROM testcases
           WHERE project_id = $1
             AND deleted_at IS NULL
             AND jira_issue_key IS NOT NULL
             AND COALESCE(status, '') <> 'Archived'
           GROUP BY jira_issue_key
         )
         SELECT j.jira_issue_key, j.summary, j.issue_type, j.status, j.priority, j.assignee, j.jira_url, j.synced_at
         FROM jira_tickets j
         LEFT JOIN linked l ON l.jira_issue_key = j.jira_issue_key
         WHERE j.project_id = $1 AND l.jira_issue_key IS NULL
         ORDER BY j.jira_updated_at DESC NULLS LAST, j.synced_at DESC
         LIMIT 50`,
        [projectId]
      )
    ]);
    const row = totals.rows[0] || {};
    const totalTickets = Number(row.total_tickets || 0);
    const coveredTickets = Number(row.covered_tickets || 0);
    const pendingTickets = Number(row.pending_tickets || 0);
    const linkedTestcases = Number(row.linked_testcases || 0);
    const connected = Boolean((status as Body).connected);
    const projectCount = normalizeJsonArray((status as Body).connectedProjects).length;
    const pendingRows = pending.rows.map((ticket) => ({
      id: null,
      externalId: ticket.jira_issue_key,
      title: ticket.summary || "Untitled Jira ticket",
      priority: ticket.priority || "Unspecified",
      status: ticket.status || "Unspecified",
      type: ticket.issue_type || "Jira ticket",
      expectedSummary: [
        ticket.assignee ? `Assignee: ${ticket.assignee}` : "Assignee: Unassigned",
        ticket.jira_url ? `URL: ${ticket.jira_url}` : ""
      ].filter(Boolean).join(" | "),
      action: "pending testcase",
      reason: "No active testcase is linked to this Jira issue key."
    }));
    const coveragePct = totalTickets ? Math.round((coveredTickets / totalTickets) * 100) : 0;
    const reply = totalTickets
      ? [
          `I checked the Jira ticket cache and testcase links for this project.`,
          `Total Jira tickets: ${totalTickets}.`,
          `Tickets with at least one active linked testcase: ${coveredTickets}.`,
          `Pending tickets for testcase writing: ${pendingTickets}.`,
          `Active linked testcases across covered tickets: ${linkedTestcases}.`,
          `Coverage by Jira ticket: ${coveragePct}%.`,
          pendingTickets ? "The pending tickets are listed in the table." : "No Jira tickets are currently pending testcase coverage."
        ].join("\n")
      : connected
        ? "Jira is connected, but I did not find synced Jira tickets in the local cache yet. Run Jira sync first, then ask me again and I will calculate pending testcase coverage."
        : "Jira is not connected for this project yet, so I cannot calculate pending testcase coverage. Connect Jira and sync tickets first.";
    return {
      reply,
      reasoningSummary: connected
        ? `Checked ${projectCount} connected Jira project mapping(s), ${totalTickets} cached Jira ticket(s), and active testcases linked by jira_issue_key. Pending means the Jira issue key has zero non-archived linked testcases. Last Jira sync seen: ${row.last_synced_at || "not available"}.`
        : "Checked Jira connection status first; coverage cannot be calculated until Jira is connected and tickets are synced.",
      actionType: "answer",
      operations: [],
      testcases: pendingRows
    };
  }

  private defaultZyraReply(message: string, existingTestcases: ZyraGenerationInput["existingTestcases"]): string {
    if (existingTestcases.length) {
      return `I found ${existingTestcases.length} related testcase(s) in the repository context. At a high level, I would use them as reference coverage, then look for gaps around negative flows, boundaries, permissions, data state, and audit behavior. Ask me to show the related testcases if you want the table.`;
    }
    if (/\b(example|sample|for example|how would|how to)\b/i.test(message)) {
      return "Example: for a password reset feature, I would first explain the expected user flow, then call out risk areas like expired tokens, reused links, throttling, account enumeration, and email delivery delays. I would only create testcase rows if you ask me to generate or save them.";
    }
    return `I can help with that as a QA-focused product assistant. I will answer directly first, then create, list, or update testcases only when you ask for that output.`;
  }

  private defaultReasoningSummary(existingCount: number): string {
    return `Reviewed available knowledge-base notes, recent chat context, and ${existingCount} nearby testcase(s). Focused on coverage gaps, duplicate avoidance, edge cases, boundary values, permissions, data integrity, state transitions, and auditability.`;
  }

  private async findProjectTestcase(projectId: string, testcaseId?: string, externalId?: string) {
    const res = await this.db.query(
      `SELECT id FROM testcases
       WHERE project_id = $1 AND deleted_at IS NULL AND (($2::uuid IS NOT NULL AND id = $2::uuid) OR ($3::text IS NOT NULL AND external_id = $3::text))
       LIMIT 1`,
      [projectId, testcaseId || null, externalId || null]
    ).catch(() => ({ rows: [] as Body[] }));
    return res.rows[0] || null;
  }

  private sanitizeZyraUpdateFields(fields: Body): Body {
    const allowed = ["title", "description", "preconditions", "postconditions", "stepsJson", "testData", "priority", "severity", "type", "automationStatus", "automationTags", "component", "status", "jiraIssueKey", "jiraUrl"];
    const cleaned: Body = {};
    for (const key of allowed) {
      if (fields[key] !== undefined && fields[key] !== null) cleaned[key] = fields[key];
    }
    if (cleaned.stepsJson) cleaned.stepsJson = this.safeSteps(cleaned.stepsJson);
    return cleaned;
  }

  private static readonly ZYRA_PATCH_FIELD_COLUMNS = [
    ["title", "title"],
    ["description", "description"],
    ["preconditions", "preconditions"],
    ["postconditions", "postconditions"],
    ["stepsJson", "steps"],
    ["testData", "test_data"],
    ["priority", "priority"],
    ["severity", "severity"],
    ["type", "type"],
    ["automationStatus", "automation_status"],
    ["automationTags", "automation_tags"],
    ["component", "component"],
    ["status", "status"],
    ["jiraIssueKey", "jira_issue_key"],
    ["jiraUrl", "jira_url"]
  ] as const;

  // Extracted so the Zyra review-batch save can run several update/archive proposals atomically
  // with each other (and with any creates in the same batch) against one shared client.
  private async patchTestCaseFromZyraWithClient(client: PoolClient, testcaseId: string, actorId: string | null, fields: Body) {
    const sets: string[] = [];
    const values: any[] = [testcaseId];
    for (const [key, column] of LegacyService.ZYRA_PATCH_FIELD_COLUMNS) {
      if (fields[key] === undefined) continue;
      values.push(column === "steps" ? JSON.stringify(this.safeSteps(fields[key])) : fields[key]);
      sets.push(`${column} = $${values.length}${column === "steps" ? "::jsonb" : ""}`);
    }
    if (!sets.length) return;
    values.push(actorId);
    await client.query(`UPDATE testcases SET ${sets.join(", ")}, updated_by = $${values.length}, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`, values);
  }

  private async patchTestCaseFromZyra(testcaseId: string, actorId: string | null, fields: Body) {
    await this.db.transaction((client) => this.patchTestCaseFromZyraWithClient(client, testcaseId, actorId, fields));
  }

  private chatDraftRow(value: Body, action: string, reason?: string): Body {
    return {
      id: value.id || null,
      externalId: value.externalId || value.external_id || "",
      title: value.title || "Untitled testcase",
      priority: value.priority || "P2",
      status: value.status || "Draft",
      type: value.type || "Functional",
      preconditions: value.preconditions || "",
      expectedSummary: value.expectedSummary || value.description || "",
      stepsJson: value.stepsJson || value.stepsSummary || value.steps || "[]",
      action,
      reason: reason || ""
    };
  }

  private chatTestcaseRow(row: Body, action: string, reason?: string): Body {
    return this.chatDraftRow({
      id: row.id,
      externalId: row.externalId,
      title: row.title,
      priority: row.priority,
      status: row.status,
      type: row.type,
      preconditions: row.preconditions,
      description: row.description,
      stepsJson: row.steps
    }, action, reason);
  }

  private formatAiTask(row: Body) {
    const item = toCamel(row as QueryResultRow);
    item.drafts = normalizeJsonArray(row.generated_payload);
    item.jiraIssueKeys = normalizeJsonArray(row.jira_issue_keys);
    item.linearIssueKeys = normalizeJsonArray(row.linear_issue_keys);
    item.sources = normalizeJsonArray(row.source_summary);
    item.activities = normalizeJsonArray(row.activity_log);
    item.tokenUsage = {
      input: Number(row.token_input || 0),
      output: Number(row.token_output || 0),
      total: Number(row.token_total || 0)
    };
    return item;
  }

  private safeSteps(value: unknown) {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string") return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private compactTitle(value: string): string {
    return value.replace(/\s+/g, " ").trim().slice(0, 72) || "Generated testcase";
  }

  private async upsertUser(email: string): Promise<string> {
    const res = await this.db.query<{ id: string }>(
      "INSERT INTO users (email, name) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET updated_at = now() RETURNING id",
      [email, email.split("@")[0]]
    );
    return res.rows[0].id;
  }

  /** The `<KEY>` half of `<KEY>-TC-<n>`: the project's configured prefix, its key, or "TC". */
  private async externalIdPrefix(projectId: string, requestedPrefix?: unknown, runner: QueryRunner = this.db): Promise<string> {
    const project = await runner.query<{ key: string; settings: unknown }>("SELECT key, settings FROM projects WHERE id = $1", [projectId]);
    const settings = parseSettings(project.rows[0]?.settings);
    return normalizeTestcaseIdPrefix(requestedPrefix)
      || normalizeTestcaseIdPrefix(settings.testcaseIdPrefix)
      || normalizeTestcaseIdPrefix(project.rows[0]?.key)
      || "TC";
  }

  // Highest sequence number already used under this prefix. Callers add 1 for a single id, or
  // claim a contiguous block for a batch. Use MAX of the trailing numeric part to avoid
  // collisions when IDs have gaps.
  //
  // Counts soft-deleted rows too: the unique index does not exclude them, so skipping a deleted
  // row's number would hand out an id that still exists and fail the insert.
  private async maxExternalIdSeq(projectId: string, key: string, runner: QueryRunner = this.db): Promise<number> {
    const maxRes = await runner.query<{ n: string }>(
      "SELECT COALESCE(MAX((regexp_match(external_id, '\\d+$'))[1]::int), 0) AS n FROM testcases WHERE project_id = $1 AND external_id LIKE $2",
      [projectId, `${key}-TC-%`]
    );
    return Number(maxRes.rows[0]?.n || 0);
  }

  /**
   * The next free `<KEY>-TC-<n>` for a project.
   *
   * `runner` matters: when allocating for an insert, this must read through the SAME transaction that
   * holds the advisory lock and will do the writing (see insertTestCase). Reading on the pool instead
   * would read outside that lock and reintroduce the race it exists to close. QueryRunner is
   * structurally typed so a PoolClient and DatabaseService both satisfy it.
   */
  private async nextExternalId(projectId: string, requestedPrefix?: unknown, runner: QueryRunner = this.db): Promise<string> {
    const key = await this.externalIdPrefix(projectId, requestedPrefix, runner);
    return `${key}-TC-${(await this.maxExternalIdSeq(projectId, key, runner)) + 1}`;
  }

  private async groupTestcases(projectId: string, column: string) {
    const res = await this.db.query<{ name: string; count: string }>(
      `SELECT COALESCE(${column}, 'Unspecified') AS name, COUNT(*) AS count FROM testcases_active WHERE project_id = $1 GROUP BY ${column}`,
      [projectId]
    );
    return res.rows.map((r) => ({ name: r.name, count: Number(r.count) }));
  }
}
