import { McpError, RpcCode, type McpTool, type McpToolContext } from "./mcp.types";

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
        return ctx.legacy.createTestCase(ctx.projectId, ctx.actorId, body);
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
