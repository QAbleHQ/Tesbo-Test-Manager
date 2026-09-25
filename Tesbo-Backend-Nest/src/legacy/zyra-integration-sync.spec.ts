import { LegacyService } from "./legacy.service";
import type { DatabaseService } from "../database/database.service";
import type { EmailService } from "../auth/email.service";
import type { PasswordService } from "../auth/password.service";
import type { AppConfigService } from "../config/app-config.service";
import type { StorageService } from "../storage/storage.service";
import type { RagIngestionService } from "../rag/rag-ingestion.service";
import type { RagRetrievalService } from "../rag/rag-retrieval.service";
import type { IntegrationSyncService } from "../integration-sync/integration-sync.service";
import type { ApiTokenService } from "../auth/api-token.service";
import type { PlanLimitsService } from "../plan-limits/plan-limits.service";
import type { CustomFieldsService } from "../custom-fields/custom-fields.service";
import type { CustomTagsService } from "../custom-tags/custom-tags.service";
import { RequestCacheService } from "../request-cache/request-cache.service";
import { ProjectLookupService } from "../request-cache/project-lookup.service";
import type { KbExtractionRunnerService } from "./kb-extraction-runner.service";
import { SuitesCacheService } from "../cache/suites-cache.service";
import { TestcasesListCacheService } from "../cache/testcases-list-cache.service";
import { ProjectOverviewCacheService } from "../cache/project-overview-cache.service";
import type Redis from "ioredis";

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

/*
 * The ticket auto-comment's pure halves — zyraTicketCommentGroups() (which committed rows belong to
 * which ticket) and zyraTicketCommentContent() (what the comment says, as Jira ADF and as markdown).
 * Both are pure, so they are exercised directly; the gating, claim and delivery around them are
 * covered in zyra-save-integration-sync.spec.ts, and end to end in e2e/api/zyra.spec.ts.
 *
 * Replaces the tests of syncTestCaseActionToIntegrations(), the per-row "Test case added by Zyra"
 * comment this feature supersedes (one comment per test case, posted regardless of the setting).
 */

const FRONTEND_URL = "https://app.example.com";

function makeLegacy(): LegacyService {
  const db = { query: jest.fn(() => Promise.resolve({ rows: [] })) } as unknown as DatabaseService;
  const requestCache = new RequestCacheService({} as unknown as AppConfigService);
  const suitesCache = new SuitesCacheService({} as unknown as Redis, {} as unknown as AppConfigService);
  const testcasesListCache = new TestcasesListCacheService({} as unknown as Redis, {} as unknown as AppConfigService);
  const projectOverviewCache = new ProjectOverviewCacheService({} as unknown as Redis, {} as unknown as AppConfigService);
  return new LegacyService(
    db,
    {} as unknown as EmailService,
    {} as unknown as PasswordService,
    { frontendUrl: FRONTEND_URL } as unknown as AppConfigService,
    {} as unknown as StorageService,
    {} as unknown as RagIngestionService,
    {} as unknown as RagRetrievalService,
    {} as unknown as IntegrationSyncService,
    {} as unknown as ApiTokenService,
    {} as unknown as PlanLimitsService,
    requestCache,
    new ProjectLookupService(db, requestCache),
    {} as unknown as KbExtractionRunnerService,
    suitesCache,
    testcasesListCache,
    projectOverviewCache,
    {} as unknown as CustomFieldsService,
    {} as unknown as CustomTagsService
  );
}
type Body = Record<string, any>;
type Action = "add" | "update" | "archive";

interface CommentInternals {
  zyraTicketCommentGroups(rows: Body[], actions: Action[]): Array<{ provider: "jira" | "linear"; issueKey: string; entries: Array<{ row: Body; action: Action }> }>;
  zyraTicketCommentContent(projectId: string, issueKey: string, entries: Array<{ row: Body; action: Action }>): { markdown: string; adf: Body };
}

function internals(svc: LegacyService): CommentInternals {
  return svc as unknown as CommentInternals;
}

function row(id: string, fields: Body = {}): Body {
  return { id, externalId: `EAD-TC-${id}`, title: `Test ${id}`, jiraIssueKey: "EAD-1", linearIssueKey: null, ...fields };
}

/** Every text node in an ADF document, in order — enough to assert on content without pinning layout. */
function adfText(node: Body): string[] {
  if (node.type === "text") return [String(node.text)];
  return (node.content ?? []).flatMap((child: Body) => adfText(child));
}

describe("zyraTicketCommentGroups — which committed rows belong to which ticket", () => {
  it("groups rows by the key each was written with, one group per ticket", () => {
    const groups = internals(makeLegacy()).zyraTicketCommentGroups(
      [row("1"), row("2", { jiraIssueKey: "EAD-2" }), row("3")],
      ["add", "add", "update"]
    );
    expect(groups.map((g) => [g.provider, g.issueKey, g.entries.map((e) => e.row.id)])).toEqual([
      ["jira", "EAD-1", ["1", "3"]],
      ["jira", "EAD-2", ["2"]]
    ]);
  });

  it("leaves out rows with no ticket, and rows with no action", () => {
    const groups = internals(makeLegacy()).zyraTicketCommentGroups(
      [row("1", { jiraIssueKey: null }), row("2"), row("3")],
      ["add", "add"]
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].entries.map((e) => e.row.id)).toEqual(["2"]);
  });

  it("puts a Linear-linked row in a Linear group", () => {
    const groups = internals(makeLegacy()).zyraTicketCommentGroups([row("1", { jiraIssueKey: null, linearIssueKey: "ENG-9" })], ["add"]);
    expect(groups).toEqual([expect.objectContaining({ provider: "linear", issueKey: "ENG-9" })]);
  });

  it("lists a row touched twice in one batch once, under its later action", () => {
    const groups = internals(makeLegacy()).zyraTicketCommentGroups([row("1"), row("1")], ["update", "archive"]);
    expect(groups[0].entries).toEqual([expect.objectContaining({ action: "archive" })]);
  });

  it("returns nothing for an empty save", () => {
    expect(internals(makeLegacy()).zyraTicketCommentGroups([], [])).toEqual([]);
  });
});

describe("zyraTicketCommentContent — what the ticket comment says", () => {
  const entries = [
    { row: row("1", { title: "Login rejects an expired session" }), action: "add" as const },
    { row: row("2", { title: "Login locks after five failures" }), action: "add" as const },
    { row: row("3", { title: "Session timeout is configurable" }), action: "update" as const }
  ];

  it("names Tesbo as the origin, and lists every test case with its id, title and link", () => {
    const { markdown, adf } = internals(makeLegacy()).zyraTicketCommentContent("p1", "EAD-1", entries);
    expect(markdown.split("\n")[0]).toBe("**Generated by Tesbo Test Manager**");
    expect(markdown).toContain("Zyra saved 3 test cases for EAD-1 in Tesbo.");
    expect(markdown).toContain(`- [EAD-TC-1](${FRONTEND_URL}/projects/p1/testcases/1) — Login rejects an expired session`);
    expect(markdown).toContain(`- [EAD-TC-3](${FRONTEND_URL}/projects/p1/testcases/3) — Session timeout is configurable`);

    const text = adfText(adf);
    expect(text[0]).toBe("Generated by Tesbo Test Manager");
    expect(text).toEqual(expect.arrayContaining(["EAD-TC-1", " — Login rejects an expired session", "EAD-TC-3"]));
    expect(JSON.stringify(adf)).toContain(`"href":"${FRONTEND_URL}/projects/p1/testcases/2"`);
  });

  it("separates added from updated test cases, with a count on each", () => {
    const { markdown } = internals(makeLegacy()).zyraTicketCommentContent("p1", "EAD-1", entries);
    const added = markdown.indexOf("**Added (2)**");
    const updated = markdown.indexOf("**Updated (1)**");
    expect(added).toBeGreaterThan(-1);
    expect(updated).toBeGreaterThan(added);
    expect(markdown).not.toContain("Archived");
  });

  it("uses the singular for one test case", () => {
    const { markdown } = internals(makeLegacy()).zyraTicketCommentContent("p1", "EAD-1", [entries[0]]);
    expect(markdown).toContain("Zyra saved 1 test case for EAD-1 in Tesbo.");
  });

  it("is valid ADF: a version-1 doc, and no empty text node (Jira rejects those)", () => {
    const { adf } = internals(makeLegacy()).zyraTicketCommentContent("p1", "EAD-1", [
      { row: row("1", { externalId: "", title: "" }), action: "add" }
    ]);
    expect(adf).toMatchObject({ type: "doc", version: 1 });
    expect(adfText(adf).every((t) => t.length > 0)).toBe(true);
    expect(adfText(adf)).toContain("Untitled test case");
  });

  it("caps the list and counts what it left out, rather than dropping it silently", () => {
    const many = Array.from({ length: 130 }, (_, i) => ({ row: row(String(i)), action: "add" as const }));
    const { markdown, adf } = internals(makeLegacy()).zyraTicketCommentContent("p1", "EAD-1", many);
    expect(markdown).toContain("Zyra saved 130 test cases");
    expect(markdown).toContain("**Added (130)**");
    expect((markdown.match(/^- \[/gm) ?? []).length).toBe(100);
    expect(markdown).toContain("…and 30 more in Tesbo.");
    expect(adfText(adf)).toContain("…and 30 more in Tesbo.");
  });

  it("escapes brackets in markdown link text so a title can't break the link", () => {
    const { markdown } = internals(makeLegacy()).zyraTicketCommentContent("p1", "EAD-1", [
      { row: row("1", { externalId: "", title: "Cart [beta] totals" }), action: "add" }
    ]);
    expect(markdown).toContain(String.raw`- [Cart \[beta\] totals](`);
  });
});
