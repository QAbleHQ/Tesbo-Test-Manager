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
import type { RequestCacheService } from "../request-cache/request-cache.service";
import type { ProjectLookupService } from "../request-cache/project-lookup.service";
import type { KbExtractionRunnerService } from "./kb-extraction-runner.service";
import type { SuitesCacheService } from "../cache/suites-cache.service";
import type { TestcasesListCacheService } from "../cache/testcases-list-cache.service";
import type { ProjectOverviewCacheService } from "../cache/project-overview-cache.service";

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

/*
 * Test-case links in Jira/Linear ticket comments, across deployments. The comment is read by other
 * people on their own machines, so a link is only written when the deployment's address is
 * reachable from outside: PUBLIC_APP_URL if set, else FRONTEND_URL. A local stack
 * (FRONTEND_URL=http://localhost:1020) used to post localhost links that opened each reader's own
 * machine — it now writes the test case's ID and title as plain text.
 */

type Body = Record<string, any>;
type Action = "add" | "update" | "archive";
type Internals = {
  zyraTicketCommentContent(projectId: string, issueKey: string, entries: Array<{ row: Body; action: Action }>): { markdown: string; adf: Body };
  zyraRetryTicketComment(projectId: string, userId: string, taskId: string, commentId: string): Promise<Body>;
  jiraPostComment(...a: unknown[]): Promise<string | null>;
};

const TC1 = "00000000-0000-4000-8000-0000000000a1";
const TC2 = "00000000-0000-4000-8000-0000000000a2";
const ENTRIES = [
  { row: { id: TC1, externalId: "PRO-TC-641", title: "Reject button is visible" }, action: "add" as const },
  { row: { id: TC2, externalId: "PRO-TC-640", title: "Reject a pending application" }, action: "update" as const }
];

function makeLegacy(config: { frontendUrl: string; publicAppUrl?: string }, db: Partial<DatabaseService> = {}): LegacyService {
  return new LegacyService(
    { query: jest.fn().mockResolvedValue({ rows: [] }), ...db } as unknown as DatabaseService,
    {} as unknown as EmailService,
    {} as unknown as PasswordService,
    { publicAppUrl: "", ...config } as unknown as AppConfigService,
    {} as unknown as StorageService,
    {} as unknown as RagIngestionService,
    {} as unknown as RagRetrievalService,
    {} as unknown as IntegrationSyncService,
    {} as unknown as ApiTokenService,
    {} as unknown as PlanLimitsService,
    {} as unknown as RequestCacheService,
    {} as unknown as ProjectLookupService,
    {} as unknown as KbExtractionRunnerService,
    {} as unknown as SuitesCacheService,
    {} as unknown as TestcasesListCacheService,
    {} as unknown as ProjectOverviewCacheService,
    {} as unknown as CustomFieldsService,
    {} as unknown as CustomTagsService
  );
}

function content(config: { frontendUrl: string; publicAppUrl?: string }) {
  return (makeLegacy(config) as unknown as Internals).zyraTicketCommentContent("p1", "KAN-4", ENTRIES);
}

function adfLinks(adf: Body): string[] {
  const out: string[] = [];
  const walk = (node: Body) => {
    for (const mark of node.marks ?? []) if (mark.type === "link") out.push(mark.attrs.href);
    for (const child of node.content ?? []) walk(child);
  };
  walk(adf);
  return out;
}

describe("ticket comment links — local, stage and production", () => {
  it("production/stage (public FRONTEND_URL): every test case links to its own page on that deployment", () => {
    const { markdown, adf } = content({ frontendUrl: "https://app.tesbo.io" });
    expect(markdown).toContain(`- [PRO-TC-641](https://app.tesbo.io/projects/p1/testcases/${TC1}) — Reject button is visible`);
    expect(adfLinks(adf)).toEqual([`https://app.tesbo.io/projects/p1/testcases/${TC1}`, `https://app.tesbo.io/projects/p1/testcases/${TC2}`]);
  });

  it("stage on its own host links to stage, not production — the base comes from that deployment's config", () => {
    const { markdown } = content({ frontendUrl: "https://stage.tesbo.io/" });
    expect(markdown).toContain(`(https://stage.tesbo.io/projects/p1/testcases/${TC1})`);
    expect(markdown).not.toContain("//projects");
  });

  it("local stack (FRONTEND_URL=localhost): no links at all — plain ID and title, never localhost", () => {
    const { markdown, adf } = content({ frontendUrl: "http://localhost:1020" });
    expect(markdown).toContain("- PRO-TC-641 — Reject button is visible");
    expect(markdown).toContain("- PRO-TC-640 — Reject a pending application");
    expect(markdown).not.toMatch(/localhost|\]\(/);
    expect(adfLinks(adf)).toEqual([]);
    expect(JSON.stringify(adf)).toContain("PRO-TC-641");
    expect(JSON.stringify(adf)).not.toContain("localhost");
  });

  it("a local stack exposed publicly (PUBLIC_APP_URL set) links to the public address, not localhost", () => {
    const { markdown } = content({ frontendUrl: "http://localhost:1020", publicAppUrl: "https://tesbo-dev.example.com" });
    expect(markdown).toContain(`(https://tesbo-dev.example.com/projects/p1/testcases/${TC1})`);
    expect(markdown).not.toContain("localhost");
  });

  it("PUBLIC_APP_URL wins over FRONTEND_URL, and a private one still produces no link", () => {
    expect(content({ frontendUrl: "https://app.tesbo.io", publicAppUrl: "https://links.tesbo.io" }).markdown).toContain("(https://links.tesbo.io/projects/");
    const privateOverride = content({ frontendUrl: "https://app.tesbo.io", publicAppUrl: "http://10.1.2.3" });
    expect(privateOverride.markdown).toContain("- PRO-TC-641 — Reject button is visible");
    expect(adfLinks(privateOverride.adf)).toEqual([]);
  });

  it("the heading, summary and sections are identical with or without links", () => {
    const linked = content({ frontendUrl: "https://app.tesbo.io" }).markdown;
    const plain = content({ frontendUrl: "http://localhost:1020" }).markdown;
    for (const text of ["**Generated by Tesbo Test Manager**", "Zyra saved 2 test cases for KAN-4 in Tesbo.", "**Added (1)**", "**Updated (1)**"]) {
      expect(linked).toContain(text);
      expect(plain).toContain(text);
    }
  });

  it("a test case with no external id still reads cleanly as plain text", () => {
    const svc = makeLegacy({ frontendUrl: "http://localhost:1020" }) as unknown as Internals;
    const { markdown } = svc.zyraTicketCommentContent("p1", "KAN-4", [{ row: { id: TC1, externalId: "", title: "Untitled draft" }, action: "add" }]);
    expect(markdown).toContain("- Untitled draft");
    expect(markdown).not.toContain("](");
  });
});

describe("Retry comment follows the same link rules", () => {
  afterEach(() => jest.restoreAllMocks());

  function retryHarness(config: { frontendUrl: string; publicAppUrl?: string }, commentText: string) {
    const failedRow = {
      id: "00000000-0000-4000-8000-0000000000c1", provider: "jira", issue_key: "KAN-4", status: "pending",
      testcase_ids: [TC1, TC2], comment_text: commentText, reason: null, posted_at: null,
      created_at: "2026-09-24T00:00:00Z", updated_at: "2026-09-24T00:00:00Z"
    };
    const query = jest.fn(async (sql: string) => {
      if (/SET status = 'pending'/.test(sql)) return { rows: [failedRow] };
      if (/FROM testcases WHERE project_id/.test(sql)) return { rows: [{ id: TC1, external_id: "PRO-TC-641", title: "Reject button is visible" }, { id: TC2, external_id: "PRO-TC-640", title: "Reject a pending application" }] };
      if (sql.startsWith("SELECT * FROM integration_ticket_comments")) return { rows: [{ ...failedRow, status: "posted" }] };
      return { rows: [] };
    });
    const svc = makeLegacy(config, { query } as unknown as Partial<DatabaseService>);
    jest.spyOn(svc as unknown as { requireProjectAccess: (...a: unknown[]) => Promise<unknown> }, "requireProjectAccess").mockResolvedValue({});
    const post = jest.spyOn(svc as unknown as Internals, "jiraPostComment").mockResolvedValue("10009");
    return { svc: svc as unknown as Internals, post };
  }

  it("a comment first posted with localhost links is re-sent from a local stack WITHOUT them, sections intact", async () => {
    const legacyLocalhostText = [
      "**Generated by Tesbo Test Manager**", "", "Zyra saved 2 test cases for KAN-4 in Tesbo.", "",
      "**Added (1)**", `- [PRO-TC-641](http://localhost:1020/projects/p1/testcases/${TC1}) — Reject button is visible`, "",
      "**Updated (1)**", `- [PRO-TC-640](http://localhost:1020/projects/p1/testcases/${TC2}) — Reject a pending application`
    ].join("\n");
    const { svc, post } = retryHarness({ frontendUrl: "http://localhost:1020" }, legacyLocalhostText);
    await svc.zyraRetryTicketComment("p1", "u1", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-0000000000c1");
    const sent = JSON.stringify(post.mock.calls[0][2]);
    expect(sent).not.toContain("localhost");
    expect(adfLinks(post.mock.calls[0][2] as Body)).toEqual([]);
    expect(sent).toContain("Updated (1)");
  });

  it("a plain-text comment keeps each test case in its section on retry (Updated stays Updated)", async () => {
    const plainText = [
      "**Generated by Tesbo Test Manager**", "", "Zyra saved 2 test cases for KAN-4 in Tesbo.", "",
      "**Added (1)**", "- PRO-TC-641 — Reject button is visible", "",
      "**Updated (1)**", "- PRO-TC-640 — Reject a pending application"
    ].join("\n");
    const { svc, post } = retryHarness({ frontendUrl: "https://app.tesbo.io" }, plainText);
    await svc.zyraRetryTicketComment("p1", "u1", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-0000000000c1");
    const sent = post.mock.calls[0][2] as Body;
    expect(JSON.stringify(sent)).toContain("Added (1)");
    expect(JSON.stringify(sent)).toContain("Updated (1)");
    // Now on a deployment with a public address, the retried comment does carry links.
    expect(adfLinks(sent)).toEqual([`https://app.tesbo.io/projects/p1/testcases/${TC1}`, `https://app.tesbo.io/projects/p1/testcases/${TC2}`]);
  });
});
