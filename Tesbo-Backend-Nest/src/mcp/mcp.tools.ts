import { BUG_SEVERITIES, LegacyService } from "../legacy/legacy.service";
import { McpError, RpcCode, type McpTool, type McpToolContext } from "./mcp.types";

/** Per-item cap for tools that loop over a single-record legacy call once per array entry — kept
 * smaller than LegacyService.MAX_BULK_TESTCASES (which backs one atomic SQL statement) since each
 * item here is its own DB round trip. */
const MAX_BULK_EXECUTIONS = 200;
const MAX_CLONE_SUITES = 100;
const MAX_CLONE_TESTCASES = 500;

/**
 * Tesbo MCP — tool registry.
 *
 * Each tool wraps an existing LegacyService method so the MCP surface stays a thin,
 * auditable adapter over the same code paths the REST API and frontend already use.
 * Writes are attributed to the dedicated MCP agent actor (ctx.actorId); columns that
 * reference users(id) rather than actors(id) — bugs.reported_by, and every Knowledge Base
 * created_by/updated_by column — use ctx.userId (the token's owning human) instead. KB's
 * mutate methods also run their own project-role check (kbRequireMutateAccess) against that
 * same user, so an MCP token inherits whatever KB permissions its owning user already has.
 *
 * Every tool operates strictly within ctx.projectId (the token's own project); the engine
 * enforces project + scope before any handler runs, so handlers never re-check auth.
 */

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new McpError(RpcCode.ToolExecutionError, `"${key}" is required and must be a non-empty string`);
  }
  return value;
}

/**
 * "[MCP] Test case created by MCP is not adding Severity" — testcases.severity is free text with no
 * CHECK constraint, so a calling LLM that guessed "Major" from a bare `severity: string` schema had
 * that stored verbatim, and the Test Case Detail dropdown (TESTCASE_SEVERITIES in testcases/page.tsx,
 * the same four values) can't select it and shows its "Select" placeholder instead. Match the
 * caller's value case-insensitively onto that vocabulary, and refuse anything else by name rather
 * than storing it or substituting a default. Omitted/empty is left exactly as the caller sent it, so
 * an unset severity keeps the create path's existing null behaviour.
 */
const SEVERITY_SCHEMA = {
  type: "string",
  enum: [...BUG_SEVERITIES],
  description: `One of ${BUG_SEVERITIES.join(", ")} (matched case-insensitively). Omit to leave severity unset.`
};

function canonicalizeSeverity(body: Record<string, unknown>): Record<string, unknown> {
  const raw = body.severity;
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return body;
  const match = BUG_SEVERITIES.find((s) => s.toLowerCase() === String(raw).trim().toLowerCase());
  if (!match) {
    throw new McpError(RpcCode.ToolExecutionError, `"severity" must be one of ${BUG_SEVERITIES.join(", ")} — got "${String(raw)}"`);
  }
  return { ...body, severity: match };
}

/**
 * Confirms a row in a project-scoped table (one with its own `project_id` column) exists and
 * belongs to ctx.projectId, for legacy methods that take no project argument of their own —
 * updateTestCase, updateSuite/deleteSuite (via requireSuiteAccess), updateBug/deleteBug/getBug
 * (via requireBugAccess), getCycle/updateCycle/deleteCycle/executions (via requireCycleAccess) all
 * derive the project from the row alone. Every id-addressed tool below that wraps one of those
 * methods must run this first, or a token could reach into another project's row by id. Not used
 * for executions, whose owning project comes from a join (executions -> cycle_items -> cycles),
 * not a direct column — see requireExecutionOwner.
 */
async function requireProjectOwnedRow(
  ctx: McpToolContext,
  table: "testcases" | "suites" | "bugs" | "cycles" | "plans",
  id: string,
  entityLabel: string
): Promise<void> {
  const owner = await ctx.db.query<{ project_id: string }>(`SELECT project_id FROM ${table} WHERE id = $1 AND deleted_at IS NULL`, [
    id
  ]);
  const projectId = owner.rows[0]?.project_id;
  if (!projectId) {
    throw new McpError(RpcCode.ToolExecutionError, `${entityLabel} not found`);
  }
  if (projectId !== ctx.projectId) {
    throw new McpError(RpcCode.ProjectScopeDenied, `${entityLabel} belongs to a different project than this token`);
  }
}

/**
 * updateTestCaseWithClient (legacy.service.ts) writes suite_id and owner_id verbatim — no
 * COALESCE, unlike every other field in that UPDATE. Any caller that omits them gets them
 * silently cleared to NULL. The frontend never notices because its edit form always re-sends the
 * currently-loaded suiteId/ownerId on every save, whether the user touched those fields or not;
 * an MCP caller has no such form state, so a plain {status: "Archived"} call was quietly
 * unassigning the test case's suite. Same reasoning update_suite already applies to parentId —
 * fetch the current values and re-supply whichever one the caller didn't mention.
 */
async function preserveOmittedSuiteAndOwner(ctx: McpToolContext, testcaseId: string, body: Record<string, unknown>): Promise<void> {
  if (body.suiteId !== undefined && body.ownerId !== undefined) return;
  const current = await ctx.legacy.getTestCase(testcaseId);
  if (body.suiteId === undefined) body.suiteId = current.suiteId ?? null;
  if (body.ownerId === undefined) body.ownerId = current.ownerId ?? null;
}

/**
 * Same confirmation as requireProjectOwnedRow, for an execution — executions has no project_id
 * column of its own, so the project comes from a join (executions -> cycle_items -> cycles).
 * Returns the owning cycle id, since every execution-detail tool needs it to call executions().
 */
async function requireExecutionOwner(ctx: McpToolContext, executionId: string): Promise<{ cycleId: string }> {
  const owner = await ctx.db.query<{ cycle_id: string; project_id: string }>(
    `SELECT ci.cycle_id, c.project_id
       FROM executions e
       JOIN cycle_items ci ON ci.id = e.cycle_item_id
       JOIN cycles c ON c.id = ci.cycle_id
      WHERE e.id = $1 AND e.deleted_at IS NULL`,
    [executionId]
  );
  const row = owner.rows[0];
  if (!row) {
    throw new McpError(RpcCode.ToolExecutionError, "Execution not found");
  }
  if (row.project_id !== ctx.projectId) {
    throw new McpError(RpcCode.ProjectScopeDenied, "Execution belongs to a different project than this token");
  }
  return { cycleId: row.cycle_id };
}

/**
 * Splits a requested id list into ones that exist in ctx.projectId's `testcases` and ones that
 * don't (foreign-project or nonexistent) — used by the bulk/workflow tools below that apply one
 * operation to many ids, so an invalid id is reported per-item rather than silently vanishing into
 * a bare "skipped" count the way addCycleTestCases's own tenancy filter does.
 */
async function partitionOwnedIds(
  ctx: McpToolContext,
  table: "testcases",
  ids: string[]
): Promise<{ validIds: string[]; invalidIds: string[] }> {
  const owned = await ctx.db.query<{ id: string }>(`SELECT id FROM ${table} WHERE id = ANY($1::uuid[]) AND project_id = $2 AND deleted_at IS NULL`, [
    ids,
    ctx.projectId
  ]);
  const validSet = new Set(owned.rows.map((r) => r.id));
  return { validIds: ids.filter((id) => validSet.has(id)), invalidIds: ids.filter((id) => !validSet.has(id)) };
}

/**
 * Renders a caught error (an McpError, a Nest exception with getResponse(), or anything else) as a
 * plain message string for a per-item result entry — the same extraction mcp.service.ts's private
 * extractMessage does for a whole RPC response, duplicated here in miniature because bulk tools
 * need it per-item, inside a single tool response, not per-call.
 */
function describeError(err: unknown): string {
  const anyErr = err as { getResponse?: () => unknown; message?: string };
  if (anyErr && typeof anyErr.getResponse === "function") {
    const resp = anyErr.getResponse();
    if (resp && typeof resp === "object") {
      const obj = resp as Record<string, unknown>;
      return String(obj.error || obj.message || anyErr.message || "Operation failed");
    }
    if (typeof resp === "string") return resp;
  }
  return err instanceof Error ? err.message : String(err);
}

export function buildMcpTools(): McpTool[] {
  return [
    {
      name: "list_projects",
      description:
        "List the project this API token is scoped to. Token credentials are project-scoped, so this returns exactly the one project the token can act on.",
      requiredScope: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async (_args: Record<string, unknown>, ctx: McpToolContext) => {
        const project = await ctx.legacy.getProject(ctx.projectId);
        return { projects: [project] };
      }
    },
    {
      name: "list_testcases",
      description:
        "List test cases in the token's project. Supports optional filters: suiteId, status, priority, type, automationStatus, jiraIssueKey, search, and pagination (limit up to 500, offset). Archived test cases are excluded unless status is \"Archived\" or includeArchived is true — pass includeArchived to match the project's total test case count (e.g. the repository summary total), which includes Archived cases.",
      requiredScope: "read",
      inputSchema: {
        type: "object",
        properties: {
          suiteId: { type: "string" },
          status: { type: "string" },
          priority: { type: "string" },
          type: { type: "string" },
          automationStatus: { type: "string" },
          jiraIssueKey: { type: "string" },
          search: { type: "string" },
          includeArchived: { type: "boolean" },
          limit: { type: "number" },
          offset: { type: "number" }
        },
        additionalProperties: false
      },
      handler: async (args, ctx) => ctx.legacy.listTestCases(ctx.projectId, args)
    },
    {
      name: "get_testcase",
      description:
        "Get one test case by id in the token's project, with its full detail: description, preconditions, postconditions, steps, test data, priority, severity, type, automation fields, component, status, estimated duration, and Jira/Linear links. Required: testcaseId.",
      requiredScope: "read",
      inputSchema: {
        type: "object",
        properties: { testcaseId: { type: "string" } },
        required: ["testcaseId"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const testcaseId = requireString(args, "testcaseId");
        await requireProjectOwnedRow(ctx, "testcases", testcaseId, "Test case");
        return ctx.legacy.getTestCase(testcaseId);
      }
    },
    {
      name: "create_testcase",
      description:
        "Create a test case in the token's project. Required: title. Optional: suiteId, description, preconditions, steps (array of {stepNumber, action, expectedResult} — expectedResult belongs on the step it applies to, not in the overall description), testData, priority, severity, type, automationStatus, component, status. The write is attributed to the Tesbo MCP agent actor.",
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          suiteId: { type: "string" },
          description: { type: "string" },
          preconditions: { type: "string" },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                stepNumber: { type: "number" },
                action: { type: "string" },
                expectedResult: { type: "string" }
              }
            }
          },
          testData: { type: "string" },
          priority: { type: "string" },
          severity: SEVERITY_SCHEMA,
          type: { type: "string" },
          automationStatus: { type: "string" },
          component: { type: "string" },
          status: { type: "string" }
        },
        required: ["title"],
        additionalProperties: true
      },
      handler: async (args, ctx) => {
        requireString(args, "title");
        // An MCP caller gets no schema enforcement (inputSchema is advisory only — see
        // mcp.service.ts), so its `steps` can drift onto synonym keys the editor doesn't read
        // (e.g. "expected" instead of "expectedResult") exactly the way Zyra's chat/task-board
        // output can. Reuse the same tolerant mapping Zyra's write paths already run through
        // rather than storing whatever shape the caller happened to send.
        // Pre-stringified to match what the create/edit modal sends (testcases/page.tsx), same as
        // Zyra's own write paths — insertTestCaseWithClient applies exactly one more encode on top
        // of whatever it's given, so a bare array here got single-encoded into a genuine jsonb
        // array, a shape the editor's parseSteps() silently discards as one blank step. See
        // "[Zyra] Test Steps... Missing After Saving Generated Test Cases".
        const body = Array.isArray(args.steps)
          ? { ...args, steps: JSON.stringify(ctx.legacy.safeSteps(args.steps)) }
          : args;
        return ctx.legacy.createTestCase(ctx.projectId, ctx.actorId, canonicalizeSeverity(body));
      }
    },
    {
      name: "update_testcase",
      description:
        "Update a test case in the token's project. Required: testcaseId. Optional: suiteId, title, description, preconditions, postconditions, steps (array of {stepNumber, action, expectedResult}), testData, priority, severity, type, automationStatus, component, status, estimatedDuration, customFieldValues. Only fields you pass are changed; omitted fields keep their current value. To archive or restore a test case, prefer archive_testcase/restore_testcase over setting status here directly. The write is attributed to the Tesbo MCP agent actor.",
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: {
          testcaseId: { type: "string" },
          suiteId: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          preconditions: { type: "string" },
          postconditions: { type: "string" },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                stepNumber: { type: "number" },
                action: { type: "string" },
                expectedResult: { type: "string" }
              }
            }
          },
          testData: { type: "string" },
          priority: { type: "string" },
          severity: SEVERITY_SCHEMA,
          type: { type: "string" },
          automationStatus: { type: "string" },
          component: { type: "string" },
          status: { type: "string" },
          estimatedDuration: { type: "string" },
          customFieldValues: { type: "object" }
        },
        required: ["testcaseId"],
        additionalProperties: true
      },
      handler: async (args, ctx) => {
        const testcaseId = requireString(args, "testcaseId");
        // updateTestCase() takes no project argument of its own — it derives the project from the
        // row it finds by id — so the tool must check project ownership itself before calling it.
        await requireProjectOwnedRow(ctx, "testcases", testcaseId, "Test case");
        const { testcaseId: _ignored, ...rest } = args;
        // Same step-synonym tolerance as create_testcase — see its handler comment.
        const body = canonicalizeSeverity(
          Array.isArray(rest.steps) ? { ...rest, steps: JSON.stringify(ctx.legacy.safeSteps(rest.steps)) } : rest
        );
        await preserveOmittedSuiteAndOwner(ctx, testcaseId, body);
        await ctx.legacy.updateTestCase(testcaseId, ctx.actorId, body);
        return ctx.legacy.getTestCase(testcaseId);
      }
    },
    {
      name: "archive_testcase",
      description:
        "Archive a test case in the token's project — sets its status to \"Archived\", the same action the app's own Archive button performs. The row is not deleted: it disappears from default list_testcases results (pass includeArchived to see it) and can be brought back with restore_testcase. Its suite assignment and owner are left exactly as they were. Required: testcaseId.",
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: { testcaseId: { type: "string" } },
        required: ["testcaseId"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const testcaseId = requireString(args, "testcaseId");
        await requireProjectOwnedRow(ctx, "testcases", testcaseId, "Test case");
        const body: Record<string, unknown> = { status: "Archived" };
        await preserveOmittedSuiteAndOwner(ctx, testcaseId, body);
        await ctx.legacy.updateTestCase(testcaseId, ctx.actorId, body);
        return ctx.legacy.getTestCase(testcaseId);
      }
    },
    {
      name: "restore_testcase",
      description:
        "Restore an archived test case in the token's project — the same action as the app's own Restore/Unarchive button. The status a test case had before it was archived is not stored anywhere, so — matching the app exactly — this always sets status back to \"Draft\", never to whatever it was before archiving. Its suite assignment and owner are left exactly as they were. Required: testcaseId.",
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: { testcaseId: { type: "string" } },
        required: ["testcaseId"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const testcaseId = requireString(args, "testcaseId");
        await requireProjectOwnedRow(ctx, "testcases", testcaseId, "Test case");
        const body: Record<string, unknown> = { status: "Draft" };
        await preserveOmittedSuiteAndOwner(ctx, testcaseId, body);
        await ctx.legacy.updateTestCase(testcaseId, ctx.actorId, body);
        return ctx.legacy.getTestCase(testcaseId);
      }
    },
    {
      name: "duplicate_testcase",
      description:
        "Create a copy of an existing test case in the token's project, without modifying the original. The copy lands in the same suite as the source, with a fresh external id, \" (copy)\" appended to the title, and every other field — steps, custom field values, automation fields, Jira/Linear links — copied verbatim. To relocate the copy afterwards, call update_testcase with its new id. Required: testcaseId.",
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: { testcaseId: { type: "string" } },
        required: ["testcaseId"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const testcaseId = requireString(args, "testcaseId");
        await requireProjectOwnedRow(ctx, "testcases", testcaseId, "Test case");
        return ctx.legacy.duplicateTestCase(testcaseId, ctx.actorId);
      }
    },
    {
      name: "bulk_create_testcases",
      description:
        `Create up to ${LegacyService.MAX_BULK_TESTCASES} test cases in the token's project in one call. Required: testcases (array; each item accepts the same fields as create_testcase — title required per item, plus optional suiteId, description, preconditions, steps, testData, priority, severity, type, automationStatus, component, status). Each item is created independently through the same path create_testcase uses — one item failing (e.g. a missing title or a too-long field) does not stop the rest from being created. The response's results array reports every item's outcome by its index in the input array, so a partial batch never silently drops a failure. This deliberately does not use the app's own bulk-import path, which is all-or-nothing (one bad row rolls back the whole batch) — per-item isolation was required here instead.`,
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: {
          testcases: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                suiteId: { type: "string" },
                description: { type: "string" },
                preconditions: { type: "string" },
                steps: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      stepNumber: { type: "number" },
                      action: { type: "string" },
                      expectedResult: { type: "string" }
                    }
                  }
                },
                testData: { type: "string" },
                priority: { type: "string" },
                severity: SEVERITY_SCHEMA,
                type: { type: "string" },
                automationStatus: { type: "string" },
                component: { type: "string" },
                status: { type: "string" }
              },
              required: ["title"]
            }
          }
        },
        required: ["testcases"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const items = Array.isArray(args.testcases) ? args.testcases : [];
        if (!items.length) throw new McpError(RpcCode.ToolExecutionError, '"testcases" must be a non-empty array');
        if (items.length > LegacyService.MAX_BULK_TESTCASES) {
          throw new McpError(
            RpcCode.ToolExecutionError,
            `A batch is limited to ${LegacyService.MAX_BULK_TESTCASES} test cases — send larger imports as several calls.`
          );
        }
        const results: Array<Record<string, unknown>> = [];
        for (let index = 0; index < items.length; index++) {
          const item = (items[index] || {}) as Record<string, unknown>;
          try {
            if (typeof item.title !== "string" || item.title.trim() === "") {
              throw new Error('"title" is required and must be a non-empty string');
            }
            // Same step-synonym tolerance as create_testcase — see its handler comment.
            const body = Array.isArray(item.steps) ? { ...item, steps: JSON.stringify(ctx.legacy.safeSteps(item.steps)) } : item;
            const created = await ctx.legacy.createTestCase(ctx.projectId, ctx.actorId, canonicalizeSeverity(body));
            results.push({ index, ok: true, testcase: created });
          } catch (err) {
            results.push({ index, ok: false, error: describeError(err) });
          }
        }
        return {
          total: items.length,
          succeeded: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
          results
        };
      }
    },
    {
      name: "bulk_update_testcases",
      description:
        `Apply the same field changes to many test cases in the token's project in one call — the same underlying bulk-update path the app's own multi-select repository actions use. Required: testcaseIds (array, up to ${LegacyService.MAX_BULK_TESTCASES}). Optional: priority, suiteId (pass "none" to clear it), status, ownerId, automationStatus — unlike update_testcase, only these five fields are bulk-writable; title/description/steps/etc. are not. Every id is validated against the token's project first: ids that don't exist, belong to another project, or are already archived-deleted are reported as failed in the results array and are never touched, while every valid id receives the same update in a single statement. Duplicate ids in the input are deduplicated before applying.`,
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: {
          testcaseIds: { type: "array", items: { type: "string" } },
          priority: { type: "string" },
          suiteId: { type: "string" },
          status: { type: "string" },
          ownerId: { type: "string" },
          automationStatus: { type: "string" }
        },
        required: ["testcaseIds"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const requestedIds = Array.isArray(args.testcaseIds) ? [...new Set(args.testcaseIds.map(String))] : [];
        if (!requestedIds.length) throw new McpError(RpcCode.ToolExecutionError, '"testcaseIds" must be a non-empty array');
        if (requestedIds.length > LegacyService.MAX_BULK_TESTCASES) {
          throw new McpError(
            RpcCode.ToolExecutionError,
            `A batch is limited to ${LegacyService.MAX_BULK_TESTCASES} test cases — send larger selections as several calls.`
          );
        }
        const { validIds, invalidIds } = await partitionOwnedIds(ctx, "testcases", requestedIds);
        if (validIds.length > 0) {
          // bulkUpdateTestCases requires a real, org-access-checkable user (it runs
          // requireProjectAccess internally) — same reasoning as update_suite/update_bug.
          await ctx.legacy.bulkUpdateTestCases(ctx.projectId, ctx.userId, {
            testcaseIds: validIds,
            priority: args.priority,
            suiteId: args.suiteId,
            status: args.status,
            ownerId: args.ownerId,
            automationStatus: args.automationStatus
          });
        }
        const results = [
          ...validIds.map((id) => ({ id, ok: true })),
          ...invalidIds.map((id) => ({ id, ok: false, error: "Test case not found in this project" }))
        ];
        return { total: requestedIds.length, succeeded: validIds.length, failed: invalidIds.length, results };
      }
    },
    {
      name: "bulk_archive_testcases",
      description:
        `Archive many test cases in the token's project in one call — sets status to "Archived" for each, the same non-destructive action archive_testcase performs one at a time; no row is ever deleted. Required: testcaseIds (array, up to ${LegacyService.MAX_BULK_TESTCASES}). Every id is validated against the token's project first: ids that don't exist or belong to another project are reported as failed in the results array and are never touched. Duplicate ids in the input are deduplicated before applying.`,
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: { testcaseIds: { type: "array", items: { type: "string" } } },
        required: ["testcaseIds"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const requestedIds = Array.isArray(args.testcaseIds) ? [...new Set(args.testcaseIds.map(String))] : [];
        if (!requestedIds.length) throw new McpError(RpcCode.ToolExecutionError, '"testcaseIds" must be a non-empty array');
        if (requestedIds.length > LegacyService.MAX_BULK_TESTCASES) {
          throw new McpError(
            RpcCode.ToolExecutionError,
            `A batch is limited to ${LegacyService.MAX_BULK_TESTCASES} test cases — send larger selections as several calls.`
          );
        }
        const { validIds, invalidIds } = await partitionOwnedIds(ctx, "testcases", requestedIds);
        if (validIds.length > 0) {
          await ctx.legacy.bulkUpdateTestCases(ctx.projectId, ctx.userId, { testcaseIds: validIds, status: "Archived" });
        }
        const results = [
          ...validIds.map((id) => ({ id, ok: true })),
          ...invalidIds.map((id) => ({ id, ok: false, error: "Test case not found in this project" }))
        ];
        return { total: requestedIds.length, succeeded: validIds.length, failed: invalidIds.length, results };
      }
    },
    {
      name: "get_testcase_bugs",
      description:
        "List every bug linked to one test case in the token's project, across every cycle it's been run in — the same bug_links relationship link_testcase_to_bug/unlink_testcase_from_bug manage. Required: testcaseId.",
      requiredScope: "read",
      inputSchema: {
        type: "object",
        properties: { testcaseId: { type: "string" } },
        required: ["testcaseId"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const testcaseId = requireString(args, "testcaseId");
        await requireProjectOwnedRow(ctx, "testcases", testcaseId, "Test case");
        return { bugs: await ctx.legacy.listBugs(ctx.projectId, { testcaseId }) };
      }
    },
    {
      name: "get_testcase_executions",
      description:
        "List every execution of one test case in the token's project, across every test cycle (test run) it has ever been part of, most recent first — the cross-cycle history list_executions cannot show (that tool is scoped to one cycle at a time). Required: testcaseId.",
      requiredScope: "read",
      inputSchema: {
        type: "object",
        properties: { testcaseId: { type: "string" } },
        required: ["testcaseId"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const testcaseId = requireString(args, "testcaseId");
        await requireProjectOwnedRow(ctx, "testcases", testcaseId, "Test case");
        return { executions: await ctx.legacy.testcaseExecutions(ctx.projectId, testcaseId) };
      }
    },
    {
      name: "link_requirement_to_testcase",
      description:
        "Link a test case to an external requirement — a Jira or Linear ticket — in the token's project, by setting its jiraIssueKey/jiraUrl or linearIssueKey/linearUrl fields, the same association get_requirement_matrix and the app's Requirements view already read from. There is no separate \"requirements\" table in this product — the ticket key on the test case IS the link, exactly as the app's own test case editor treats it, so this does not require the ticket to already be synced from a connected Jira/Linear integration. Required: testcaseId, and exactly one of jiraIssueKey or linearIssueKey (not both). Optional: jiraUrl/linearUrl to record the ticket's URL alongside it. Calling this again with the same key is safe: it re-sets the same value rather than creating a duplicate link, and more than one test case may legitimately link to the same requirement.",
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: {
          testcaseId: { type: "string" },
          jiraIssueKey: { type: "string" },
          jiraUrl: { type: "string" },
          linearIssueKey: { type: "string" },
          linearUrl: { type: "string" }
        },
        required: ["testcaseId"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const testcaseId = requireString(args, "testcaseId");
        const jiraIssueKey = typeof args.jiraIssueKey === "string" ? args.jiraIssueKey.trim() : "";
        const linearIssueKey = typeof args.linearIssueKey === "string" ? args.linearIssueKey.trim() : "";
        if (!jiraIssueKey && !linearIssueKey) {
          throw new McpError(RpcCode.ToolExecutionError, `"jiraIssueKey" or "linearIssueKey" is required`);
        }
        if (jiraIssueKey && linearIssueKey) {
          throw new McpError(RpcCode.ToolExecutionError, 'Provide only one of "jiraIssueKey" or "linearIssueKey" per call');
        }
        await requireProjectOwnedRow(ctx, "testcases", testcaseId, "Test case");
        const body: Record<string, unknown> = jiraIssueKey
          ? { jiraIssueKey, jiraUrl: typeof args.jiraUrl === "string" ? args.jiraUrl : undefined }
          : { linearIssueKey, linearUrl: typeof args.linearUrl === "string" ? args.linearUrl : undefined };
        await preserveOmittedSuiteAndOwner(ctx, testcaseId, body);
        await ctx.legacy.updateTestCase(testcaseId, ctx.actorId, body);
        return ctx.legacy.getTestCase(testcaseId);
      }
    },
    {
      name: "unlink_requirement_from_testcase",
      description:
        "Remove a test case's link to an external requirement in the token's project, by clearing its jiraIssueKey/jiraUrl (provider \"jira\") or linearIssueKey/linearUrl (provider \"linear\") fields — nothing else on the test case changes, and the Jira/Linear ticket itself is untouched. Required: testcaseId, provider (\"jira\" or \"linear\"). Safe to call on a test case with no such link: it is a no-op, not an error.",
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: {
          testcaseId: { type: "string" },
          provider: { type: "string" }
        },
        required: ["testcaseId", "provider"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const testcaseId = requireString(args, "testcaseId");
        const provider = requireString(args, "provider");
        if (provider !== "jira" && provider !== "linear") {
          throw new McpError(RpcCode.ToolExecutionError, '"provider" must be "jira" or "linear"');
        }
        await requireProjectOwnedRow(ctx, "testcases", testcaseId, "Test case");
        const body: Record<string, unknown> =
          provider === "jira" ? { jiraIssueKey: null, jiraUrl: null } : { linearIssueKey: null, linearUrl: null };
        await preserveOmittedSuiteAndOwner(ctx, testcaseId, body);
        await ctx.legacy.updateTestCase(testcaseId, ctx.actorId, body);
        return ctx.legacy.getTestCase(testcaseId);
      }
    },
    {
      name: "list_suites",
      description:
        "List every suite (folder) in the token's project. Returned flat, not nested — each row carries parentId (null for a root suite) so a client can build the tree itself, plus testCaseCount (direct children only) and recursiveTestCaseCount (the whole subtree), matching the app's Test Case Repository sidebar. No filters or pagination: the project's suites are always returned in full, ordered by position then name.",
      requiredScope: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async (_args, ctx) => ({ suites: await ctx.legacy.listSuites(ctx.projectId) })
    },
    {
      name: "get_suite",
      description:
        "Get one suite (folder) by id in the token's project: name, parentId, position, testCaseCount (direct children) and recursiveTestCaseCount (whole subtree). Required: suiteId.",
      requiredScope: "read",
      inputSchema: {
        type: "object",
        properties: { suiteId: { type: "string" } },
        required: ["suiteId"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const suiteId = requireString(args, "suiteId");
        await requireProjectOwnedRow(ctx, "suites", suiteId, "Suite");
        const suite = (await ctx.legacy.listSuites(ctx.projectId)).find((s) => s.id === suiteId);
        if (!suite) throw new McpError(RpcCode.ToolExecutionError, "Suite not found");
        return suite;
      }
    },
    {
      name: "create_suite",
      description:
        "Create a suite (folder) in the token's project. Required: name. Optional: parentId (nest under another suite), position.",
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          parentId: { type: "string" },
          position: { type: "number" }
        },
        required: ["name"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        requireString(args, "name");
        return ctx.legacy.createSuite(ctx.projectId, args);
      }
    },
    {
      name: "update_suite",
      description:
        "Rename, move, or reposition a suite in the token's project. Required: suiteId. Optional: name, parentId, position. IMPORTANT: the app's own update always sets the parent from what you send — omitting parentId does NOT keep the current parent the way omitting a field does on update_testcase. This tool defaults parentId to the suite's current parent when you don't pass it, so a rename-only or position-only call won't silently move the suite to the project's root; pass parentId: null explicitly to move it to the root, or another suite's id to reparent it.",
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: {
          suiteId: { type: "string" },
          name: { type: "string" },
          parentId: { type: ["string", "null"] },
          position: { type: "number" }
        },
        required: ["suiteId"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const suiteId = requireString(args, "suiteId");
        // updateSuite() takes no project argument of its own — it derives the project from the
        // row it finds by id (requireSuiteAccess) — so the tool must check project ownership
        // itself before calling it, same as update_testcase.
        await requireProjectOwnedRow(ctx, "suites", suiteId, "Suite");
        const suites = await ctx.legacy.listSuites(ctx.projectId);
        const existing = suites.find((s) => s.id === suiteId);
        if (!existing) throw new McpError(RpcCode.ToolExecutionError, "Suite not found");
        // updateSuite writes parent_id verbatim (no COALESCE) — default to the current parent so an
        // omitted parentId doesn't un-parent the suite. See this tool's description.
        const parentId = args.parentId !== undefined ? (args.parentId as string | null) : existing.parentId;
        await ctx.legacy.updateSuite(ctx.userId, suiteId, { name: args.name, parentId, position: args.position });
        return (await ctx.legacy.listSuites(ctx.projectId)).find((s) => s.id === suiteId);
      }
    },
    {
      name: "clone_test_suite",
      description:
        `Clone a suite (folder) in the token's project, including every sub-suite beneath it and their test cases — a deep copy, not a reference. The original suite, its sub-suites, and its test cases are never modified; every cloned row is brand new (fresh suite ids, fresh test case ids and external ids, custom field values copied — the same duplicate_testcase does per case). Required: suiteId (the source). Optional: name (the cloned root suite's name; defaults to "<source name> (copy)"), parentId (where the cloned root suite lands; defaults to the source suite's own current parent, i.e. cloning as a sibling — pass null explicitly for the project root). Bounded to ${MAX_CLONE_SUITES} suites and ${MAX_CLONE_TESTCASES} test cases per call; a subtree over either limit is refused up front, before anything is created, rather than partially cloned.`,
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: {
          suiteId: { type: "string" },
          name: { type: "string" },
          parentId: { type: ["string", "null"] }
        },
        required: ["suiteId"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const sourceSuiteId = requireString(args, "suiteId");
        await requireProjectOwnedRow(ctx, "suites", sourceSuiteId, "Suite");
        if (typeof args.parentId === "string" && args.parentId) {
          await requireProjectOwnedRow(ctx, "suites", args.parentId, "Destination parent suite");
        }

        const allSuites = await ctx.legacy.listSuites(ctx.projectId);
        const byParent = new Map<string, typeof allSuites>();
        for (const s of allSuites) {
          const key = (s.parentId as string) || "";
          if (!byParent.has(key)) byParent.set(key, []);
          byParent.get(key)!.push(s);
        }
        const source = allSuites.find((s) => s.id === sourceSuiteId);
        if (!source) throw new McpError(RpcCode.ToolExecutionError, "Suite not found");

        // Source-first walk of the subtree, so every parent is cloned before the children that
        // need its freshly created id.
        // visited guards against a cycle in suites.parent_id — createSuite/updateSuite accept any
        // parentId unconditionally (no write-time cycle guard, unlike moveKnowledgeFolder), the
        // same reasoning listSuitesUncached's own recursive query already carries a path guard for.
        const subtree: typeof allSuites = [];
        const visited = new Set<string>();
        const walk = (node: (typeof allSuites)[number]) => {
          if (visited.has(node.id)) return;
          visited.add(node.id);
          subtree.push(node);
          for (const child of byParent.get(node.id) || []) walk(child);
        };
        walk(source);
        if (subtree.length > MAX_CLONE_SUITES) {
          throw new McpError(
            RpcCode.ToolExecutionError,
            `This suite has ${subtree.length} suites in its subtree, over the ${MAX_CLONE_SUITES}-suite clone limit.`
          );
        }

        // Read-only pre-count across the whole subtree BEFORE creating anything, so a limit
        // breach is refused cleanly rather than leaving a half-cloned suite tree behind.
        let totalTestcases = 0;
        for (const node of subtree) {
          const page = await ctx.legacy.listTestCases(ctx.projectId, { suiteId: node.id, includeArchived: true, limit: 1 });
          totalTestcases += Number(page.total || 0);
        }
        if (totalTestcases > MAX_CLONE_TESTCASES) {
          throw new McpError(
            RpcCode.ToolExecutionError,
            `This suite's subtree has ${totalTestcases} test cases, over the ${MAX_CLONE_TESTCASES}-test-case clone limit. Clone a narrower suite instead.`
          );
        }

        const idMap = new Map<string, string>();
        const clonedSuites: Array<Record<string, unknown>> = [];
        for (const node of subtree) {
          const isRoot = node.id === sourceSuiteId;
          const newParentId = isRoot
            ? args.parentId !== undefined
              ? (args.parentId as string | null)
              : ((node.parentId as string | null) ?? null)
            : idMap.get(node.parentId as string) || null;
          const created = (await ctx.legacy.createSuite(ctx.projectId, {
            name: isRoot ? (typeof args.name === "string" && args.name ? args.name : `${node.name} (copy)`) : node.name,
            parentId: newParentId,
            position: node.position
          })) as Record<string, any>;
          idMap.set(node.id as string, created.id);
          clonedSuites.push(created);
        }

        const clonedTestcases: Array<Record<string, unknown>> = [];
        for (const node of subtree) {
          const { rows } = await ctx.legacy.listTestCases(ctx.projectId, { suiteId: node.id, includeArchived: true, limit: 500 });
          for (const tc of rows as Array<{ id: string }>) {
            const duplicated = (await ctx.legacy.duplicateTestCase(tc.id, ctx.actorId)) as Record<string, any>;
            // duplicateTestCase already copied ownerId from the source onto `duplicated` — this
            // relocation call must re-supply it (updateTestCase writes owner_id verbatim, no
            // COALESCE), or moving the copy into its new suite silently drops its owner.
            await ctx.legacy.updateTestCase(duplicated.id, ctx.actorId, {
              suiteId: idMap.get(node.id as string),
              ownerId: duplicated.ownerId ?? null
            });
            clonedTestcases.push({ sourceId: tc.id, clonedId: duplicated.id });
          }
        }

        return {
          sourceSuiteId,
          clonedSuiteId: idMap.get(sourceSuiteId),
          suiteCount: clonedSuites.length,
          suites: clonedSuites,
          testcaseCount: clonedTestcases.length,
          testcases: clonedTestcases
        };
      }
    },
    {
      name: "list_test_cycles",
      description:
        "List test cycles (test runs) in the token's project, newest first. Each row includes per-status execution counts (totalCases, passed, failed, blocked, skipped, untested), matching the app's own Test Runs list. No filters or pagination — every cycle in the project is returned.",
      requiredScope: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async (_args, ctx) => ({ cycles: await ctx.legacy.listCycles(ctx.projectId) })
    },
    {
      name: "get_test_cycle",
      description:
        "Get one test cycle (test run) by id in the token's project: name, description, environment, buildVersion, releaseName, planId, and per-status execution counts. If the cycle was seeded from a plan (planId set), the linked plan's own detail is attached as `plan` (null if there is no plan, or it can no longer be reached). A cycle has no single \"suite\" of its own — each of its executions carries the suiteId of the test case it ran, available via list_executions/get_execution. Required: cycleId.",
      requiredScope: "read",
      inputSchema: {
        type: "object",
        properties: { cycleId: { type: "string" } },
        required: ["cycleId"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const cycleId = requireString(args, "cycleId");
        await requireProjectOwnedRow(ctx, "cycles", cycleId, "Test cycle");
        const cycle = (await ctx.legacy.listCycles(ctx.projectId)).find((c) => c.id === cycleId);
        if (!cycle) throw new McpError(RpcCode.ToolExecutionError, "Test cycle not found");
        let plan: unknown = null;
        if (cycle.planId) {
          // Best-effort: getPlan() re-checks access on the plan's own project via requirePlanAccess,
          // which is redundant here but the only path that reuses its logic rather than
          // re-deriving plan shape by hand. "Where available" means this degrades to null on any
          // failure rather than failing the whole cycle lookup over an enrichment field.
          try {
            plan = await ctx.legacy.getPlan(ctx.userId, cycle.planId);
          } catch {
            plan = null;
          }
        }
        return { ...cycle, plan };
      }
    },
    {
      name: "create_cycle_from_plan",
      description:
        "Create a test run (cycle) in the token's project, optionally seeded from a plan. Required: name. Optional: planId, description, environment, buildVersion, releaseName.",
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          planId: { type: "string" },
          description: { type: "string" },
          environment: { type: "string" },
          buildVersion: { type: "string" },
          releaseName: { type: "string" }
        },
        required: ["name"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        requireString(args, "name");
        return ctx.legacy.createCycle(ctx.projectId, args);
      }
    },
    {
      name: "create_cycle_from_testcases",
      description:
        "Create a test cycle (test run) in the token's project and add the given test cases to it in one call — the same two-step workflow (create the run, then add test cases) the app's own UI performs; there is no single-statement backend path that does both. Required: name, testcaseIds (array). Optional: description, environment, buildVersion, releaseName, planId. Every testcaseId is validated against the token's project first — ids that don't exist or belong to another project are listed in invalidTestcaseIds and are never added, rather than silently vanishing into a bare skipped count. Duplicate ids in the input are deduplicated before adding.",
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          testcaseIds: { type: "array", items: { type: "string" } },
          description: { type: "string" },
          environment: { type: "string" },
          buildVersion: { type: "string" },
          releaseName: { type: "string" },
          planId: { type: "string" }
        },
        required: ["name", "testcaseIds"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        requireString(args, "name");
        const requestedIds = Array.isArray(args.testcaseIds) ? [...new Set(args.testcaseIds.map(String))] : [];
        if (!requestedIds.length) throw new McpError(RpcCode.ToolExecutionError, '"testcaseIds" must be a non-empty array');
        if (typeof args.planId === "string" && args.planId) {
          await requireProjectOwnedRow(ctx, "plans", args.planId, "Plan");
        }
        const { validIds, invalidIds } = await partitionOwnedIds(ctx, "testcases", requestedIds);
        const cycle = await ctx.legacy.createCycle(ctx.projectId, {
          name: args.name,
          description: args.description,
          environment: args.environment,
          buildVersion: args.buildVersion,
          releaseName: args.releaseName,
          planId: args.planId
        });
        // addCycleTestCases requires a real, org-access-checkable user (requireCycleAccess), same
        // reasoning as update_suite/update_bug/bulk_update_testcases.
        const addResult =
          validIds.length > 0
            ? await ctx.legacy.addCycleTestCases(cycle.id, ctx.userId, { testcaseIds: validIds })
            : { requested: 0, added: 0, skipped: 0 };
        return {
          cycle,
          testcasesRequested: requestedIds.length,
          testcasesAdded: addResult.added,
          invalidTestcaseIds: invalidIds
        };
      }
    },
    {
      name: "record_execution_result",
      description:
        "Record the result of a test execution. Required: executionId, status (e.g. Passed/Failed/Blocked/Skipped). Optional: actualResult, defectKey, defectUrl. The execution must belong to the token's project. Attributed to the token's owning user, not the MCP agent actor — see the handler's own comment on why.",
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: {
          executionId: { type: "string" },
          status: { type: "string" },
          actualResult: { type: "string" },
          defectKey: { type: "string" },
          defectUrl: { type: "string" }
        },
        required: ["executionId", "status"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const executionId = requireString(args, "executionId");
        requireString(args, "status");
        // Enforce project scope: an execution reached only via its id must still belong to
        // this token's project, otherwise a token could mutate results in another project.
        await requireExecutionOwner(ctx, executionId);
        // updateExecution's second argument must be a real user id: it runs requireProjectAccess
        // (workspace/organization_members lookup) before writing, and also stores it as
        // executions.executed_by, which — unlike testcases/bugs' created_by — references users(id),
        // not actors(id). ctx.actorId (the "tesbo-mcp" agent) has no organization_members row, so
        // passing it here 404'd as "Workspace not found" for every caller, every time.
        await ctx.legacy.updateExecution(executionId, ctx.userId, args);
        return { ok: true, executionId, status: args.status };
      }
    },
    {
      name: "list_executions",
      description:
        "List every execution in a test cycle (test run) in the token's project, in run order. Each row carries the execution's result fields (status, assigneeId, actualResult, executedAt, defectKey, defectUrl, evidenceCount) and the test case snapshot it ran against (title, externalId, priority, type, suiteId, description, steps, testData, automationStatus, automationTags — frozen at the time the run was seeded, so it does not drift if the live test case changes afterwards). No filters or pagination — matches the app's own Test Run screen, which loads every execution in the run at once. Required: cycleId.",
      requiredScope: "read",
      inputSchema: {
        type: "object",
        properties: { cycleId: { type: "string" } },
        required: ["cycleId"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const cycleId = requireString(args, "cycleId");
        await requireProjectOwnedRow(ctx, "cycles", cycleId, "Test cycle");
        return { executions: await ctx.legacy.executions(cycleId) };
      }
    },
    {
      name: "get_execution",
      description:
        "Get one execution's complete result and test-case-snapshot detail by id in the token's project — the same fields list_executions returns, for a single row. Required: executionId.",
      requiredScope: "read",
      inputSchema: {
        type: "object",
        properties: { executionId: { type: "string" } },
        required: ["executionId"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const executionId = requireString(args, "executionId");
        const { cycleId } = await requireExecutionOwner(ctx, executionId);
        const execution = (await ctx.legacy.executions(cycleId)).find((e) => e.id === executionId);
        if (!execution) throw new McpError(RpcCode.ToolExecutionError, "Execution not found");
        return execution;
      }
    },
    {
      name: "update_execution_result",
      description:
        "Update an execution's result in the token's project — every field the app's own Test Run screen exposes for it: status (Untested/Passed/Failed/Blocked/Skipped/Retest), actualResult, defectKey, defectUrl (defectKey/defectUrl are cleared automatically the moment status is set to anything other than Failed, matching the app), assigneeId (must already be a member of this project; pass null or \"\" to unassign). Required: executionId; every other field is optional and omitting one leaves it unchanged. Attributed to the token's owning user, not the MCP agent actor — see record_execution_result's handler comment for why.",
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: {
          executionId: { type: "string" },
          status: { type: "string" },
          actualResult: { type: "string" },
          defectKey: { type: "string" },
          defectUrl: { type: "string" },
          assigneeId: { type: ["string", "null"] }
        },
        required: ["executionId"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const executionId = requireString(args, "executionId");
        const { cycleId } = await requireExecutionOwner(ctx, executionId);
        const { executionId: _ignored, ...body } = args;
        // Same reasoning as record_execution_result: updateExecution requires a real user id.
        await ctx.legacy.updateExecution(executionId, ctx.userId, body);
        return (await ctx.legacy.executions(cycleId)).find((e) => e.id === executionId);
      }
    },
    {
      name: "bulk_record_execution_results",
      description:
        `Record results for up to ${MAX_BULK_EXECUTIONS} executions in the token's project in one call, each with its own status and fields — not one uniform result applied to all of them. Required: results (array of {executionId, status?, actualResult?, defectKey?, defectUrl?, assigneeId?} — the same fields as update_execution_result; executionId is the only one required per item). Each item is recorded independently through the exact path update_execution_result/record_execution_result use — one item failing (e.g. an executionId from another project, or one that doesn't exist) does not stop the rest from being recorded. The response's results array reports every item's outcome by its index in the input array.`,
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: {
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                executionId: { type: "string" },
                status: { type: "string" },
                actualResult: { type: "string" },
                defectKey: { type: "string" },
                defectUrl: { type: "string" },
                assigneeId: { type: ["string", "null"] }
              },
              required: ["executionId"]
            }
          }
        },
        required: ["results"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const items = Array.isArray(args.results) ? args.results : [];
        if (!items.length) throw new McpError(RpcCode.ToolExecutionError, '"results" must be a non-empty array');
        if (items.length > MAX_BULK_EXECUTIONS) {
          throw new McpError(
            RpcCode.ToolExecutionError,
            `A batch is limited to ${MAX_BULK_EXECUTIONS} executions — send larger selections as several calls.`
          );
        }
        const outcomes: Array<Record<string, unknown>> = [];
        for (let index = 0; index < items.length; index++) {
          const item = (items[index] || {}) as Record<string, unknown>;
          const executionId = typeof item.executionId === "string" ? item.executionId : "";
          try {
            if (!executionId.trim()) throw new Error('"executionId" is required and must be a non-empty string');
            await requireExecutionOwner(ctx, executionId);
            const { executionId: _ignored, ...body } = item;
            await ctx.legacy.updateExecution(executionId, ctx.userId, body);
            outcomes.push({ index, executionId, ok: true });
          } catch (err) {
            outcomes.push({ index, executionId: executionId || null, ok: false, error: describeError(err) });
          }
        }
        return {
          total: items.length,
          succeeded: outcomes.filter((r) => r.ok).length,
          failed: outcomes.filter((r) => !r.ok).length,
          results: outcomes
        };
      }
    },
    {
      name: "get_test_execution_summary",
      description:
        "Get an accurate execution-status summary in the token's project, computed live from actual execution rows (not a cached or hardcoded figure) — counts of Passed, Failed, Blocked, Skipped, Untested, Retest, and a total. Optional: cycleId, to scope the summary to one test cycle (test run); omitted, it aggregates across every cycle in the project.",
      requiredScope: "read",
      inputSchema: {
        type: "object",
        properties: { cycleId: { type: "string" } },
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const zeros = { Passed: 0, Failed: 0, Blocked: 0, Skipped: 0, Untested: 0, Retest: 0, total: 0 };
        if (typeof args.cycleId === "string" && args.cycleId) {
          const cycleId = args.cycleId;
          await requireProjectOwnedRow(ctx, "cycles", cycleId, "Test cycle");
          const report = await ctx.legacy.executionReport(ctx.projectId, { filterBy: "run", filterValue: cycleId });
          const row = (report.rows[0] as Record<string, number> | undefined) || zeros;
          return { scope: "cycle", cycleId, ...zeros, ...row };
        }
        const report = await ctx.legacy.executionReport(ctx.projectId, { filterBy: "overall" });
        const totals = { ...zeros };
        for (const row of report.rows as Array<Record<string, number>>) {
          totals.Passed += Number(row.Passed || 0);
          totals.Failed += Number(row.Failed || 0);
          totals.Blocked += Number(row.Blocked || 0);
          totals.Skipped += Number(row.Skipped || 0);
          totals.Untested += Number(row.Untested || 0);
          totals.Retest += Number(row.Retest || 0);
          totals.total += Number(row.total || 0);
        }
        return { scope: "project", cycleCount: report.rows.length, ...totals };
      }
    },
    {
      name: "list_bugs",
      description:
        "List bugs in the token's project, newest first. Supports optional filters: status, testcaseId, cycleId (when both testcaseId and cycleId are given, they must be satisfied by the same link, not two different links on the same bug), assigneeId (pass \"unassigned\" for bugs with no assignee). No pagination — every match is returned, the same as the app's own Bugs list.",
      requiredScope: "read",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string" },
          testcaseId: { type: "string" },
          cycleId: { type: "string" },
          assigneeId: { type: "string" }
        },
        additionalProperties: false
      },
      handler: async (args, ctx) => ({ bugs: await ctx.legacy.listBugs(ctx.projectId, args) })
    },
    {
      name: "get_bug",
      description:
        "Get one bug by id in the token's project, including its links (to test cases, cycles, and executions) and attachments. Required: bugId.",
      requiredScope: "read",
      inputSchema: {
        type: "object",
        properties: { bugId: { type: "string" } },
        required: ["bugId"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const bugId = requireString(args, "bugId");
        await requireProjectOwnedRow(ctx, "bugs", bugId, "Bug");
        return ctx.legacy.getBug(bugId);
      }
    },
    {
      name: "create_bug",
      description:
        "Report a bug in the token's project. Required: title. Optional: description, status, externalUrl, links (array of {testcaseId, cycleId, executionId}). Reported-by is the token's owning user.",
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          status: { type: "string" },
          externalUrl: { type: "string" },
          links: { type: "array" }
        },
        required: ["title"],
        additionalProperties: true
      },
      handler: async (args, ctx) => {
        requireString(args, "title");
        // reported_by references users(id), so use the token's human owner, not the agent actor.
        return ctx.legacy.createBug(ctx.projectId, ctx.userId, args);
      }
    },
    {
      name: "update_bug",
      description:
        "Update a bug in the token's project. Required: bugId. Optional: title, description, status, severity (Critical/High/Medium/Low), priority (P0/P1/P2/P3 — pass null or \"\" to clear it back to untriaged), externalUrl, assigneeId (must already be a member of this project; pass null or \"\" to unassign), links (array of {testcaseId, cycleId, executionId} — replaces the bug's existing links entirely when present, it does not merge with them). Fields you omit keep their current value, except priority/assigneeId which use the explicit-clear convention above.",
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: {
          bugId: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          status: { type: "string" },
          severity: { type: "string" },
          priority: { type: ["string", "null"] },
          externalUrl: { type: "string" },
          assigneeId: { type: ["string", "null"] },
          links: { type: "array" }
        },
        required: ["bugId"],
        additionalProperties: true
      },
      handler: async (args, ctx) => {
        const bugId = requireString(args, "bugId");
        // updateBug() takes no project argument of its own — it derives the project from the row
        // it finds by id (requireBugAccess) — so the tool must check project ownership itself
        // before calling it, same as update_testcase/update_suite.
        await requireProjectOwnedRow(ctx, "bugs", bugId, "Bug");
        const { bugId: _ignored, ...body } = args;
        return ctx.legacy.updateBug(ctx.userId, bugId, body);
      }
    },
    {
      name: "link_testcase_to_bug",
      description:
        "Link a test case to an existing bug in the token's project (a bug_links row), optionally scoped to a specific cycle/execution. Required: bugId, testcaseId. Optional: cycleId, executionId (if executionId is given and belongs to a live run, that execution is set to Failed — the same behavior linking a bug from a test run in the app has). Calling this again with the same bugId+testcaseId (+cycleId) is safe: the underlying link is looked up by that combination first, so it is updated in place rather than duplicated.",
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: {
          bugId: { type: "string" },
          testcaseId: { type: "string" },
          cycleId: { type: "string" },
          executionId: { type: "string" }
        },
        required: ["bugId", "testcaseId"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const bugId = requireString(args, "bugId");
        const testcaseId = requireString(args, "testcaseId");
        await requireProjectOwnedRow(ctx, "bugs", bugId, "Bug");
        await requireProjectOwnedRow(ctx, "testcases", testcaseId, "Test case");
        if (typeof args.cycleId === "string" && args.cycleId) {
          await requireProjectOwnedRow(ctx, "cycles", args.cycleId, "Test cycle");
        }
        if (typeof args.executionId === "string" && args.executionId) {
          await requireExecutionOwner(ctx, args.executionId);
        }
        return ctx.legacy.addBugLink(ctx.userId, bugId, {
          testcaseId,
          cycleId: args.cycleId,
          executionId: args.executionId
        });
      }
    },
    {
      name: "unlink_testcase_from_bug",
      description:
        "Remove the link between a test case and a bug in the token's project, without deleting the test case or the bug — only the bug_links relationship row is removed. Required: bugId, testcaseId. Optional: cycleId, to disambiguate when the same test case is linked to this bug from more than one cycle (without it, the first matching link is removed). Safe to call when the two are not linked: it is a no-op, not an error — the response's wasLinked field tells you which happened.",
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: {
          bugId: { type: "string" },
          testcaseId: { type: "string" },
          cycleId: { type: "string" }
        },
        required: ["bugId", "testcaseId"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const bugId = requireString(args, "bugId");
        const testcaseId = requireString(args, "testcaseId");
        await requireProjectOwnedRow(ctx, "bugs", bugId, "Bug");
        await requireProjectOwnedRow(ctx, "testcases", testcaseId, "Test case");
        const cycleId = typeof args.cycleId === "string" && args.cycleId ? args.cycleId : undefined;
        const bug = await ctx.legacy.getBug(bugId);
        const links = (bug.links || []) as Array<{ id: string; testcaseId: string | null; cycleId: string | null }>;
        const match = links.find((l) => l.testcaseId === testcaseId && (cycleId === undefined || l.cycleId === cycleId));
        if (!match) {
          return { ok: true, bugId, testcaseId, wasLinked: false };
        }
        await ctx.legacy.removeBugLink(ctx.userId, bugId, match.id);
        return { ok: true, bugId, testcaseId, wasLinked: true };
      }
    },
    {
      name: "get_requirement_matrix",
      description:
        "Return the requirement/traceability matrix for the token's project: every test case with its runs, latest execution status, and any linked bugs.",
      requiredScope: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async (_args, ctx) => ctx.legacy.requirementMatrix(ctx.projectId)
    },
    {
      name: "search_knowledge_base",
      description:
        "Search the Knowledge Base (folders, documents, files) in the token's project by keyword. Required: q. Optional: type (\"all\" | \"folder\" | \"document\" | \"file\", default \"all\"), date (\"today\" | \"week\" | \"month\"). Matched documents are returned with their full content.",
      requiredScope: "read",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string" },
          type: { type: "string" },
          date: { type: "string" }
        },
        required: ["q"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        requireString(args, "q");
        return ctx.legacy.searchKnowledgeBase(ctx.projectId, ctx.userId, args);
      }
    },
    {
      name: "list_knowledge_documents",
      description:
        "List Knowledge Base documents in the token's project, newest-updated first. Optional filter: documentType (general/requirement_note/test_data_note/api_note/release_note/ai_memory). Always excludes archived (soft-deleted) documents. This list is project-wide, not folder-scoped, and is capped at the 200 most recently updated documents with no further pagination — use search_knowledge_base for keyword search, or list_knowledge_folders/get_knowledge_folder to browse by location.",
      requiredScope: "read",
      inputSchema: {
        type: "object",
        properties: { documentType: { type: "string" } },
        additionalProperties: false
      },
      handler: async (args, ctx) => ctx.legacy.listKnowledgeDocuments(ctx.projectId, ctx.userId, args)
    },
    {
      name: "get_knowledge_document",
      description:
        "Get one Knowledge Base document by id in the token's project: full content (contentText/contentHtml/contentJson), documentType, status, sync-source info if it's mirrored from a connected Jira/Linear integration (sourceProvider, syncedByName, sourceSyncedAt, isReadOnly), creator/updater, and its folder breadcrumb from the project's root folder down to it. Required: documentId.",
      requiredScope: "read",
      inputSchema: {
        type: "object",
        properties: { documentId: { type: "string" } },
        required: ["documentId"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const documentId = requireString(args, "documentId");
        return ctx.legacy.getKnowledgeDocument(ctx.projectId, ctx.userId, documentId);
      }
    },
    {
      name: "create_knowledge_document",
      description:
        "Create a Knowledge Base document in the token's project. Required: title, folderId (use search_knowledge_base or the folder tree to find one). Optional: contentText, contentHtml, contentJson, documentType. Attributed to the token's owning user.",
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          folderId: { type: "string" },
          contentText: { type: "string" },
          contentHtml: { type: "string" },
          contentJson: { type: "object" },
          documentType: { type: "string" }
        },
        required: ["title", "folderId"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        requireString(args, "title");
        requireString(args, "folderId");
        return ctx.legacy.createKnowledgeDocument(ctx.projectId, ctx.userId, args);
      }
    },
    {
      name: "update_knowledge_document",
      description:
        "Update a Knowledge Base document's title or content. Required: documentId. Optional: title, contentText, contentHtml, contentJson, documentType, status. Rejected if the document is synced from Jira/Linear (read-only) or is Zyra's AI Memory document being renamed. Only the document's creator, or a project owner/manager, may update it.",
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string" },
          title: { type: "string" },
          contentText: { type: "string" },
          contentHtml: { type: "string" },
          contentJson: { type: "object" },
          documentType: { type: "string" },
          status: { type: "string" }
        },
        required: ["documentId"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const documentId = requireString(args, "documentId");
        return ctx.legacy.updateKnowledgeDocument(ctx.projectId, ctx.userId, documentId, args);
      }
    },
    {
      name: "move_knowledge_document",
      description:
        "Move a Knowledge Base document into a different folder. Required: documentId, folderId. Only the document's creator, or a project owner/manager, may move it.",
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string" },
          folderId: { type: "string" }
        },
        required: ["documentId", "folderId"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const documentId = requireString(args, "documentId");
        requireString(args, "folderId");
        return ctx.legacy.moveKnowledgeDocument(ctx.projectId, ctx.userId, documentId, args);
      }
    },
    {
      name: "archive_knowledge_document",
      description:
        "Archive (soft-delete) a Knowledge Base document in the token's project — the document and its content are kept, not permanently removed, and can be brought back with restore_knowledge_document at the same folder location it was archived from. Refused with a ToolExecutionError for the Zyra AI Memory document, which can't be archived at all. Only the document's creator, or a project owner/manager, may archive it. Required: documentId. An already-archived document is excluded from lookup the same way a nonexistent one is, so archiving it again answers \"Document not found\", not a silent no-op.",
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: { documentId: { type: "string" } },
        required: ["documentId"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const documentId = requireString(args, "documentId");
        return ctx.legacy.deleteKnowledgeDocument(ctx.projectId, ctx.userId, documentId);
      }
    },
    {
      name: "restore_knowledge_document",
      description:
        "Restore an archived Knowledge Base document in the token's project. Archiving never moves or rewrites a document — only restore_knowledge_document's own is_deleted/deleted_at flags change — so the restored document's content and folder location are exactly as they were. Requires the token's user to hold an owner or manager project role (stricter than archive_knowledge_document, which the document's own creator may also do). Required: documentId. Calling this on a document that is not currently archived is a graceful no-op: it succeeds and returns the document unchanged rather than erroring.",
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: { documentId: { type: "string" } },
        required: ["documentId"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const documentId = requireString(args, "documentId");
        return ctx.legacy.restoreKnowledgeDocument(ctx.projectId, ctx.userId, documentId);
      }
    },
    {
      name: "list_knowledge_folders",
      description:
        "List every Knowledge Base folder in the token's project as a nested tree, rooted at the project's own root folder — each folder carries a children array of its own subfolders, preserving the existing hierarchy (not a flat list). No filters or pagination: the whole tree is always returned.",
      requiredScope: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async (_args, ctx) => ctx.legacy.getKnowledgeFolderTree(ctx.projectId, ctx.userId)
    },
    {
      name: "get_knowledge_folder",
      description:
        "Get one Knowledge Base folder by id in the token's project: name, description, parentFolderId, isRoot, and its breadcrumb path from the project's root folder down to it. Does not include child counts — use list_knowledge_folders for the folder tree, or search_knowledge_base to find what's inside it. Required: folderId.",
      requiredScope: "read",
      inputSchema: {
        type: "object",
        properties: { folderId: { type: "string" } },
        required: ["folderId"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const folderId = requireString(args, "folderId");
        return ctx.legacy.getKnowledgeFolder(ctx.projectId, ctx.userId, folderId);
      }
    },
    {
      name: "create_knowledge_folder",
      description:
        "Create a Knowledge Base folder in the token's project. Required: name. Optional: parentFolderId (defaults to the project's root folder), description.",
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          parentFolderId: { type: "string" },
          description: { type: "string" }
        },
        required: ["name"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        requireString(args, "name");
        return ctx.legacy.createKnowledgeFolder(ctx.projectId, ctx.userId, args);
      }
    },
    {
      name: "update_knowledge_folder",
      description:
        "Rename or re-describe a Knowledge Base folder. Required: folderId. Optional: name, description. Only the folder's creator, or a project owner/manager, may update it.",
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: {
          folderId: { type: "string" },
          name: { type: "string" },
          description: { type: "string" }
        },
        required: ["folderId"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const folderId = requireString(args, "folderId");
        return ctx.legacy.updateKnowledgeFolder(ctx.projectId, ctx.userId, folderId, args);
      }
    },
    {
      name: "move_knowledge_folder",
      description:
        "Move a Knowledge Base folder under a different parent folder. Required: folderId, parentFolderId. The root folder cannot be moved, and a folder cannot be moved into itself or one of its own subfolders. Only the folder's creator, or a project owner/manager, may move it.",
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: {
          folderId: { type: "string" },
          parentFolderId: { type: "string" }
        },
        required: ["folderId", "parentFolderId"],
        additionalProperties: false
      },
      handler: async (args, ctx) => {
        const folderId = requireString(args, "folderId");
        requireString(args, "parentFolderId");
        return ctx.legacy.moveKnowledgeFolder(ctx.projectId, ctx.userId, folderId, args);
      }
    }
  ];
}
