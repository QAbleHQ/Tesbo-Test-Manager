"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { IconKey } from "@tabler/icons-react";
import {
  API_BASE,
  listApiKeys,
  createApiKey,
  revokeApiKey,
  getMcpUrl,
  type ApiToken,
  type ApiTokenWithSecret,
} from "@/lib/api";
import { Button, Card, Modal, Input, Field, FieldLabel, StatusChip, CopyButton } from "@/components/ui";
import { PageHeader, StandardPageLayout, Breadcrumbs } from "@/components/workflows";
import { useAppData } from "@/components/app/AppDataProvider";
import { useProjectData } from "@/components/project/ProjectDataProvider";

type ConnectTab = "claudeCode" | "claudeDesktop" | "other";

function normalizeRole(role: string): "owner" | "manager" | "qa_engineer" {
  const n = (role ?? "").trim().toLowerCase().replace(/-/g, "_").replace(/ /g, "_");
  if (n === "owner") return "owner";
  if (["manager", "admin", "test_manager"].includes(n)) return "manager";
  return "qa_engineer";
}

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function scopeLabel(scopes: string[]): string {
  const hasRead = scopes.includes("read");
  const hasWrite = scopes.includes("write");
  if (hasRead && hasWrite) return "Read & Write";
  if (hasWrite) return "Write only";
  return "Read only";
}

/**
 * Grouped, one-line-per-tool reference for a human skimming this page. This is presentational
 * only — it has no bearing on how an MCP client (Claude Code, Claude Desktop, …) discovers or
 * chooses tools, which always comes from a live `tools/list` call against the running server
 * (mcp.tools.ts), not from anything rendered here. Keep names and grouping in sync with that file
 * when a tool is added, renamed, or removed.
 */
const MCP_TOOL_GROUPS: Array<{ category: string; tools: Array<{ name: string; blurb: string }> }> = [
  {
    category: "Projects",
    tools: [{ name: "list_projects", blurb: "The single project this token is scoped to." }],
  },
  {
    category: "Test cases",
    tools: [
      { name: "list_testcases", blurb: "Filter/search/paginate test cases." },
      { name: "get_testcase", blurb: "Full detail for one test case." },
      { name: "create_testcase", blurb: "Create a test case." },
      { name: "update_testcase", blurb: "Update a test case (only the fields you pass)." },
      { name: "archive_testcase", blurb: "Archive a test case (non-destructive)." },
      { name: "restore_testcase", blurb: "Restore an archived test case." },
      { name: "duplicate_testcase", blurb: "Copy a test case within its suite." },
      { name: "bulk_create_testcases", blurb: "Create many test cases in one call." },
      { name: "bulk_update_testcases", blurb: "Apply the same field changes to many test cases." },
      { name: "bulk_archive_testcases", blurb: "Archive many test cases in one call." },
      { name: "get_testcase_bugs", blurb: "Bugs linked to one test case." },
      { name: "get_testcase_executions", blurb: "A test case's run history across every cycle." },
      { name: "link_requirement_to_testcase", blurb: "Attach a Jira/Linear ticket to a test case." },
      { name: "unlink_requirement_from_testcase", blurb: "Remove a test case's Jira/Linear link." },
    ],
  },
  {
    category: "Suites",
    tools: [
      { name: "list_suites", blurb: "Every suite (folder) in the project, flat." },
      { name: "get_suite", blurb: "One suite by id." },
      { name: "create_suite", blurb: "Create a suite." },
      { name: "update_suite", blurb: "Rename, move, or reposition a suite." },
      { name: "clone_test_suite", blurb: "Deep-copy a suite, its sub-suites, and their test cases." },
    ],
  },
  {
    category: "Test cycles & executions",
    tools: [
      { name: "list_test_cycles", blurb: "Every test cycle (test run) in the project." },
      { name: "get_test_cycle", blurb: "One test cycle, with its linked plan if any." },
      { name: "create_cycle_from_plan", blurb: "Create a test run, optionally seeded from a plan." },
      { name: "create_cycle_from_testcases", blurb: "Create a test run and add test cases to it." },
      { name: "list_executions", blurb: "Every execution in a test cycle, in run order." },
      { name: "get_execution", blurb: "One execution's result and test-case snapshot." },
      { name: "record_execution_result", blurb: "Record a Pass/Fail/etc. result." },
      { name: "update_execution_result", blurb: "Update an execution's result fields." },
      { name: "bulk_record_execution_results", blurb: "Record results for many executions in one call." },
      { name: "get_test_execution_summary", blurb: "Live Pass/Fail/Blocked/… counts, project- or cycle-wide." },
    ],
  },
  {
    category: "Bugs",
    tools: [
      { name: "list_bugs", blurb: "Bugs in the project, newest first." },
      { name: "get_bug", blurb: "One bug, with its links and attachments." },
      { name: "create_bug", blurb: "File a bug." },
      { name: "update_bug", blurb: "Update a bug's fields." },
      { name: "link_testcase_to_bug", blurb: "Link a test case (and optionally a run) to a bug." },
      { name: "unlink_testcase_from_bug", blurb: "Remove a test case/bug link." },
    ],
  },
  {
    category: "Requirements",
    tools: [{ name: "get_requirement_matrix", blurb: "Full traceability matrix: cases, runs, latest status, bugs." }],
  },
  {
    category: "Knowledge Base",
    tools: [
      { name: "search_knowledge_base", blurb: "Keyword search across folders, documents, and files." },
      { name: "list_knowledge_documents", blurb: "Recently updated documents, project-wide." },
      { name: "get_knowledge_document", blurb: "One document's full content and location." },
      { name: "create_knowledge_document", blurb: "Create a document in a folder." },
      { name: "update_knowledge_document", blurb: "Update a document's title or content." },
      { name: "move_knowledge_document", blurb: "Move a document to a different folder." },
      { name: "archive_knowledge_document", blurb: "Archive (soft-delete) a document." },
      { name: "restore_knowledge_document", blurb: "Restore an archived document." },
      { name: "list_knowledge_folders", blurb: "The whole folder tree, rooted at the project." },
      { name: "get_knowledge_folder", blurb: "One folder, with its breadcrumb." },
      { name: "create_knowledge_folder", blurb: "Create a folder." },
      { name: "update_knowledge_folder", blurb: "Rename or re-describe a folder." },
      { name: "move_knowledge_folder", blurb: "Move a folder under a different parent." },
    ],
  },
];

export default function ApiTokensPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const { currentUser } = useAppData();
  const { project, projectMembers } = useProjectData();
  const projectName = String(project.name || "");

  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [tokensLoading, setTokensLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createStep, setCreateStep] = useState<"form" | "reveal">("form");
  const [newTokenName, setNewTokenName] = useState("");
  const [newTokenScopes, setNewTokenScopes] = useState({ read: true, write: true });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [revealedToken, setRevealedToken] = useState<ApiTokenWithSecret | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const [connectTab, setConnectTab] = useState<ConnectTab>("claudeCode");

  const loadTokens = useCallback(async () => {
    try {
      const list = await listApiKeys(projectId);
      setTokens(list);
      setListError(null);
    } catch {
      setListError("Failed to load API tokens.");
    } finally {
      setTokensLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!currentUser) {
      router.replace("/login");
      return;
    }
    setCurrentUserId(currentUser.userId);
    loadTokens().catch(() => {});
  }, [loadTokens, projectId, router, currentUser]);

  const currentUserRole = currentUserId
    ? normalizeRole(projectMembers.find((m) => m.userId === currentUserId)?.role ?? "qa_engineer")
    : "qa_engineer";
  const canManageApiTokens = currentUserRole === "owner" || currentUserRole === "manager";

  function openCreateModal() {
    setNewTokenName("");
    setNewTokenScopes({ read: true, write: true });
    setCreateError(null);
    setCreateStep("form");
    setCreateModalOpen(true);
  }

  async function handleCreateToken(e: FormEvent) {
    e.preventDefault();
    const name = newTokenName.trim();
    if (!name) {
      setCreateError("Name is required.");
      return;
    }
    const scopes = Object.entries(newTokenScopes)
      .filter(([, checked]) => checked)
      .map(([scope]) => scope);
    if (scopes.length === 0) {
      setCreateError("Select at least one scope.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const result = await createApiKey(projectId, { name, scopes });
      setTokens((prev) => [result, ...prev]);
      setRevealedToken(result);
      setCreateStep("reveal");
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create token.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(tokenId: string) {
    setRevokingId(tokenId);
    try {
      await revokeApiKey(projectId, tokenId);
      setTokens((prev) => prev.filter((t) => t.id !== tokenId));
    } catch {
      setListError("Failed to revoke token.");
    } finally {
      setRevokingId(null);
    }
  }

  function closeCreateModal() {
    if (createStep === "reveal") return;
    setCreateModalOpen(false);
  }

  function finishReveal() {
    setCreateModalOpen(false);
    setCreateStep("form");
    setNewTokenName("");
    setNewTokenScopes({ read: true, write: true });
  }

  const mcpUrl = getMcpUrl(projectId);
  const tokenForSnippets = revealedToken?.token ?? "<YOUR_API_TOKEN>";

  const claudeCodeCli = `claude mcp add --transport http tesbo ${mcpUrl} --header "Authorization: Bearer ${tokenForSnippets}"`;
  const mcpJsonSnippet = `{
  "mcpServers": {
    "tesbo": {
      "type": "http",
      "url": "${mcpUrl}",
      "headers": { "Authorization": "Bearer ${tokenForSnippets}" }
    }
  }
}`;
  const curlSnippet = `curl -X POST '${mcpUrl}' \\
  -H 'Authorization: Bearer ${tokenForSnippets}' \\
  -H 'Content-Type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;

  /*
   * Windows PowerShell aliases `curl` to Invoke-WebRequest, which doesn't understand -X/-H/-d or
   * backslash line continuation — pasting the curl snippet above into PowerShell fails with
   * "A parameter cannot be found that matches parameter name 'X'." This is PowerShell-native
   * instead, so a Windows user has something that actually runs as pasted.
   */
  const powershellSnippet = `$headers = @{ Authorization = "Bearer ${tokenForSnippets}" }
$body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
Invoke-RestMethod -Uri "${mcpUrl}" -Method Post -Headers $headers -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 10`;

  const reporterInstall = `npm install --save-dev @tesbox/playwright-reporter
npx @tesbox/playwright-reporter init`;

  /*
   * baseUrl and projectId are prefilled and committed; the token deliberately is not. Hardcoding a
   * token into playwright.config.ts is the one mistake this panel could actively cause, so the
   * snippet leaves it to the environment and the row above says why.
   */
  const reporterConfig = `// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: [
    ['list'],
    ['@tesbox/playwright-reporter', {
      baseUrl: '${API_BASE}',
      projectId: '${projectId}',
    }],
  ],
});`;

  const reporterTag = `test('user can reset password', { tag: '@tesbo.testId("TES-1042")' }, async ({ page }) => {
  // …
});`;

  const header = (
    <PageHeader
      title={
        <>
          <IconKey size={26} stroke={1.75} />
          API &amp; MCP access
        </>
      }
      subtitle="Create tokens, connect AI agents like Claude Code or Claude Desktop, and report automated test results into this project."
      breadcrumb={
        <Breadcrumbs
          items={[
            { label: "Projects", href: "/projects" },
            { label: projectName || "Project", href: `/projects/${projectId}/dashboard` },
            { label: "Settings", href: `/projects/${projectId}/settings?tab=apiTokens` },
            { label: "API & MCP" },
          ]}
        />
      }
    />
  );

  return (
    <StandardPageLayout header={header}>
      {!canManageApiTokens && (
        <Card className="p-4">
          <p className="text-sm text-[var(--muted)]">
            Only project managers and owners can create or revoke API tokens.
          </p>
        </Card>
      )}

      {canManageApiTokens && (
        <div>
          <Button type="button" onClick={openCreateModal}>
            Create token
          </Button>
        </div>
      )}

      {listError && <p className="text-sm text-[var(--error-foreground)]">{listError}</p>}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="tesbo-table min-w-full text-sm">
            <thead>
              <tr className="text-left text-[var(--muted)]">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Token</th>
                <th className="px-4 py-3 font-medium">Scopes</th>
                <th className="px-4 py-3 font-medium">Last used</th>
                <th className="px-4 py-3 font-medium">Created</th>
                {canManageApiTokens && <th className="px-4 py-3 font-medium text-right">Action</th>}
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => (
                <tr key={token.id}>
                  <td className="px-4 py-3 text-[var(--foreground)]">{token.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{token.tokenPrefix}</td>
                  <td className="px-4 py-3">
                    <StatusChip tone="brand" dot>
                      {scopeLabel(token.scopes)}
                    </StatusChip>
                  </td>
                  <td className="px-4 py-3 text-[var(--muted)]">{formatDate(token.lastUsedAt)}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{formatDate(token.createdAt)}</td>
                  {canManageApiTokens && (
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => handleRevoke(token.id)}
                        disabled={revokingId === token.id}
                        className="text-[var(--error-foreground)] hover:underline disabled:opacity-50"
                      >
                        {revokingId === token.id ? "Revoking…" : "Revoke"}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {!tokensLoading && tokens.length === 0 && (
                <tr>
                  <td colSpan={canManageApiTokens ? 6 : 5} className="px-4 py-6 text-center text-[var(--muted)]">
                    No API tokens yet.
                  </td>
                </tr>
              )}
              {tokensLoading && (
                <tr>
                  <td colSpan={canManageApiTokens ? 6 : 5} className="px-4 py-6 text-center text-[var(--muted)]">
                    Loading tokens…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-4 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-[var(--foreground)]">Connect an MCP client</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {revealedToken
              ? "Showing the token you just created — copy it into your config now."
              : <>Replace <code className="font-mono text-xs">&lt;YOUR_API_TOKEN&gt;</code> below with a token from the list above.</>}
          </p>
        </div>

        <div className="flex gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-1 text-sm">
          <button
            type="button"
            onClick={() => setConnectTab("claudeCode")}
            className={`flex-1 rounded-md px-3 py-1.5 font-medium transition-colors ${
              connectTab === "claudeCode" ? "bg-[var(--surface)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted)]"
            }`}
          >
            Claude Code
          </button>
          <button
            type="button"
            onClick={() => setConnectTab("claudeDesktop")}
            className={`flex-1 rounded-md px-3 py-1.5 font-medium transition-colors ${
              connectTab === "claudeDesktop" ? "bg-[var(--surface)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted)]"
            }`}
          >
            Claude Desktop
          </button>
          <button
            type="button"
            onClick={() => setConnectTab("other")}
            className={`flex-1 rounded-md px-3 py-1.5 font-medium transition-colors ${
              connectTab === "other" ? "bg-[var(--surface)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted)]"
            }`}
          >
            Other / curl
          </button>
        </div>

        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Registering a new MCP server doesn&apos;t reach a session that&apos;s already running — it&apos;s only
          picked up on startup. Start a new Claude Code session (or, in the VS Code / JetBrains extension, run{" "}
          <strong>Developer: Reload Window</strong>) before the new tools show up in{" "}
          <code className="font-mono">/mcp</code>.
        </div>

        {connectTab === "claudeCode" && (
          <div className="space-y-3">
            <p className="text-sm text-[var(--muted)]">Run this once from your terminal:</p>
            <div className="relative">
              <pre className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3 pr-12 font-mono text-xs text-[var(--foreground)] overflow-x-auto">{claudeCodeCli}</pre>
              <CopyButton value={claudeCodeCli} iconOnly className="absolute right-2 top-2" />
            </div>
            <p className="text-sm text-[var(--muted)]">Or add this to <code className="font-mono text-xs">.mcp.json</code> (project) or <code className="font-mono text-xs">~/.claude.json</code> (user):</p>
            <div className="relative">
              <pre className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3 pr-12 font-mono text-xs text-[var(--foreground)] overflow-x-auto whitespace-pre">{mcpJsonSnippet}</pre>
              <CopyButton value={mcpJsonSnippet} iconOnly className="absolute right-2 top-2" />
            </div>
          </div>
        )}

        {connectTab === "claudeDesktop" && (
          <div className="space-y-3">
            <p className="text-sm text-[var(--muted)]">
              Add this to your Claude Desktop config — macOS: <code className="font-mono text-xs">~/Library/Application Support/Claude/claude_desktop_config.json</code>, Windows: <code className="font-mono text-xs">%APPDATA%\Claude\claude_desktop_config.json</code>
            </p>
            <div className="relative">
              <pre className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3 pr-12 font-mono text-xs text-[var(--foreground)] overflow-x-auto whitespace-pre">{mcpJsonSnippet}</pre>
              <CopyButton value={mcpJsonSnippet} iconOnly className="absolute right-2 top-2" />
            </div>
          </div>
        )}

        {connectTab === "other" && (
          <div className="space-y-3">
            <p className="text-sm text-[var(--muted)]">
              Any MCP-compatible client can call the JSON-RPC 2.0 endpoint directly:
            </p>
            <div className="space-y-1">
              <p className="text-xs font-medium text-[var(--muted-soft)]">macOS / Linux (curl)</p>
              <div className="relative">
                <pre className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3 pr-12 font-mono text-xs text-[var(--foreground)] overflow-x-auto whitespace-pre">{curlSnippet}</pre>
                <CopyButton value={curlSnippet} iconOnly className="absolute right-2 top-2" />
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium text-[var(--muted-soft)]">
                Windows (PowerShell) — <code className="font-mono">curl</code> here is aliased to Invoke-WebRequest and rejects curl-style flags, so use this instead
              </p>
              <div className="relative">
                <pre className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3 pr-12 font-mono text-xs text-[var(--foreground)] overflow-x-auto whitespace-pre">{powershellSnippet}</pre>
                <CopyButton value={powershellSnippet} iconOnly className="absolute right-2 top-2" />
              </div>
            </div>
            <p className="text-xs text-[var(--muted-soft)]">
              Protocol methods: <code className="font-mono">initialize</code>, <code className="font-mono">ping</code>, <code className="font-mono">tools/list</code>, <code className="font-mono">tools/call</code>. An MCP client (Claude Code, Claude Desktop, …) discovers every tool and its full schema live via <code className="font-mono">tools/list</code> — the groups below are just a quick human reference for what&apos;s available.
            </p>
            <div className="space-y-3">
              {MCP_TOOL_GROUPS.map((group) => (
                <div key={group.category}>
                  <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted-soft)]">{group.category}</p>
                  <ul className="mt-1 divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
                    {group.tools.map((tool) => (
                      <li key={tool.name} className="flex flex-wrap items-baseline gap-x-2 px-3 py-1.5 text-xs">
                        <code className="font-mono text-[var(--foreground)]">{tool.name}</code>
                        <span className="text-[var(--muted)]">{tool.blurb}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card className="p-4 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-[var(--foreground)]">Connect your test framework</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Report automated results into this project. Your suite opens one Test Run and fills in each
            case&apos;s result, linked by the case id you tag the test with.
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium text-[var(--foreground)]">Playwright</p>
          <p className="text-sm text-[var(--muted)]">
            The reporter needs these three values. The first two are not secrets — commit them.
          </p>
          <div className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
            <div className="flex items-start gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <code className="font-mono text-xs text-[var(--foreground)]">TESBO_BASE_URL</code>
                <p className="mt-0.5 break-all font-mono text-xs text-[var(--muted)]">{API_BASE}</p>
                <p className="mt-0.5 text-xs text-[var(--muted-soft)]">
                  This project&apos;s API host. Not the web app host — pointing at the app makes every call
                  404 while your suite stays green.
                </p>
              </div>
              <CopyButton value={API_BASE} iconOnly />
            </div>
            <div className="flex items-start gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <code className="font-mono text-xs text-[var(--foreground)]">TESBO_PROJECT_ID</code>
                <p className="mt-0.5 break-all font-mono text-xs text-[var(--muted)]">{projectId}</p>
                <p className="mt-0.5 text-xs text-[var(--muted-soft)]">This project.</p>
              </div>
              <CopyButton value={projectId} iconOnly />
            </div>
            <div className="flex items-start gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <code className="font-mono text-xs text-[var(--foreground)]">TESBO_API_TOKEN</code>
                {revealedToken ? (
                  <p className="mt-0.5 break-all font-mono text-xs text-[var(--muted)]">{revealedToken.token}</p>
                ) : (
                  <p className="mt-0.5 text-xs text-[var(--muted)]">
                    Create a token above with <strong>Read</strong> and <strong>Write</strong>. It is shown only
                    once, so keep it in your CI secrets — never in{" "}
                    <code className="font-mono">playwright.config.ts</code>.
                  </p>
                )}
              </div>
              {revealedToken && <CopyButton value={revealedToken.token} iconOnly />}
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium text-[var(--foreground)]">Install it in your Playwright project</p>
          <div className="relative">
            <pre className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3 pr-12 font-mono text-xs text-[var(--foreground)] overflow-x-auto whitespace-pre">{reporterInstall}</pre>
            <CopyButton value={reporterInstall} iconOnly className="absolute right-2 top-2" />
          </div>
          <p className="text-xs text-[var(--muted-soft)]">
            <code className="font-mono">init</code> asks for the three values and verifies they work together
            before you wire anything up. You can paste the MCP URL above in place of{" "}
            <code className="font-mono">TESBO_BASE_URL</code> — it reads the host and the project id out of it.
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium text-[var(--foreground)]">Register the reporter</p>
          <div className="relative">
            <pre className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3 pr-12 font-mono text-xs text-[var(--foreground)] overflow-x-auto whitespace-pre">{reporterConfig}</pre>
            <CopyButton value={reporterConfig} iconOnly className="absolute right-2 top-2" />
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium text-[var(--foreground)]">Tag each test with the case it validates</p>
          <div className="relative">
            <pre className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3 pr-12 font-mono text-xs text-[var(--foreground)] overflow-x-auto whitespace-pre">{reporterTag}</pre>
            <CopyButton value={reporterTag} iconOnly className="absolute right-2 top-2" />
          </div>
          <p className="text-xs text-[var(--muted-soft)]">
            Replace <code className="font-mono">TES-1042</code> with the test case&apos;s id as shown in Tesbo.
            The leading <code className="font-mono">@</code> is required — Playwright rejects any tag without it.
            Untagged tests are counted and skipped, not failed.
          </p>
        </div>

        <p className="text-xs text-[var(--muted-soft)]">
          Full setup, CI provenance, evidence and troubleshooting:{" "}
          <a
            href="https://www.npmjs.com/package/@tesbox/playwright-reporter"
            target="_blank"
            rel="noreferrer"
            className="text-[var(--primary)] hover:underline"
          >
            @tesbox/playwright-reporter
          </a>
          .
        </p>
      </Card>

      <Modal
        open={createModalOpen}
        onClose={closeCreateModal}
        title={createStep === "form" ? "Create API token" : "Copy your new token"}
      >
        {createStep === "form" && (
          <form onSubmit={handleCreateToken} className="space-y-4">
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input
                type="text"
                value={newTokenName}
                onChange={(e) => setNewTokenName(e.target.value)}
                placeholder="e.g. Claude Code — my laptop"
                disabled={creating}
                autoFocus
              />
            </Field>
            <div className="space-y-3">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={newTokenScopes.read}
                  onChange={(e) => setNewTokenScopes((prev) => ({ ...prev, read: e.target.checked }))}
                  className="mt-0.5"
                  disabled={creating}
                />
                <div>
                  <span className="text-sm font-medium text-[var(--foreground)]">Read</span>
                  <p className="text-xs text-[var(--muted)] mt-0.5">
                    List and search test cases, suites, cycles, and results.
                  </p>
                </div>
              </label>
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={newTokenScopes.write}
                  onChange={(e) => setNewTokenScopes((prev) => ({ ...prev, write: e.target.checked }))}
                  className="mt-0.5"
                  disabled={creating}
                />
                <div>
                  <span className="text-sm font-medium text-[var(--foreground)]">Write</span>
                  <p className="text-xs text-[var(--muted)] mt-0.5">
                    Create test cases, suites, cycles, execution results, and bugs.
                  </p>
                </div>
              </label>
            </div>
            {createError && <p className="text-sm text-[var(--error-foreground)]">{createError}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={closeCreateModal} disabled={creating}>
                Cancel
              </Button>
              <Button type="submit" disabled={creating}>
                {creating ? "Creating…" : "Create token"}
              </Button>
            </div>
          </form>
        )}

        {createStep === "reveal" && revealedToken && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Input
                type="text"
                readOnly
                value={revealedToken.token}
                onClick={(e) => (e.target as HTMLInputElement).select()}
                className="flex-1 bg-[var(--surface-secondary)] font-mono truncate"
              />
              <CopyButton value={revealedToken.token} label="Copy" />
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              This is the only time you&apos;ll see this token. Copy it now — for example, paste it directly into the connection instructions below.
            </div>
            <div className="flex justify-end">
              <Button type="button" onClick={finishReveal}>
                Done
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </StandardPageLayout>
  );
}
