import { McpError, RpcCode, type McpTool, type McpToolContext } from "./mcp.types";

/**
 * Tesbo MCP — tool registry.
 *
 * Each tool wraps an existing LegacyService method so the MCP surface stays a thin,
 * auditable adapter over the same code paths the REST API and frontend already use.
 * Writes are attributed to the dedicated MCP agent actor (ctx.actorId); the one column
 * that references users(id) rather than actors(id) — bugs.reported_by — uses ctx.userId.
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
      name: "create_testcase",
      description:
        "Create a test case in the token's project. Required: title. Optional: suiteId, description, preconditions, steps (array), testData, priority, severity, type, automationStatus, component, status. The write is attributed to the Tesbo MCP agent actor.",
      requiredScope: "write",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          suiteId: { type: "string" },
          description: { type: "string" },
          preconditions: { type: "string" },
          steps: { type: "array" },
          testData: { type: "string" },
          priority: { type: "string" },
          severity: { type: "string" },
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
        return ctx.legacy.createTestCase(ctx.projectId, ctx.actorId, args);
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
      name: "record_execution_result",
      description:
        "Record the result of a test execution. Required: executionId, status (e.g. Passed/Failed/Blocked/Skipped). Optional: actualResult, defectKey, defectUrl. The execution must belong to the token's project. Attributed to the Tesbo MCP agent actor.",
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
        const owner = await ctx.db.query<{ project_id: string }>(
          `SELECT c.project_id
             FROM executions e
             JOIN cycle_items ci ON ci.id = e.cycle_item_id
             JOIN cycles c ON c.id = ci.cycle_id
            WHERE e.id = $1 AND e.deleted_at IS NULL`,
          [executionId]
        );
        const projectId = owner.rows[0]?.project_id;
        if (!projectId) {
          throw new McpError(RpcCode.ToolExecutionError, "Execution not found");
        }
        if (projectId !== ctx.projectId) {
          throw new McpError(RpcCode.ProjectScopeDenied, "Execution belongs to a different project than this token");
        }
        await ctx.legacy.updateExecution(executionId, ctx.actorId, args);
        return { ok: true, executionId, status: args.status };
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
      name: "get_requirement_matrix",
      description:
        "Return the requirement/traceability matrix for the token's project: every test case with its runs, latest execution status, and any linked bugs.",
      requiredScope: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async (_args, ctx) => ctx.legacy.requirementMatrix(ctx.projectId)
    }
  ];
}
