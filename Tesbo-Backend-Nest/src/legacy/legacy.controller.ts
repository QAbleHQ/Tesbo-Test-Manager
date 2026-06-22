import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res
} from "@nestjs/common";
import type { Response } from "express";
import * as XLSX from "xlsx";
import { AuthenticatedRequest } from "../common/request.types";
import { LegacyService } from "./legacy.service";

@Controller()
export class LegacyController {
  constructor(private readonly legacy: LegacyService) {}

  private csvEscape(value: unknown): string {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  private rowsToCsv(headers: string[], rows: Record<string, unknown>[]): string {
    return [
      headers.join(","),
      ...rows.map((row) => headers.map((header) => this.csvEscape(row[header])).join(","))
    ].join("\n");
  }

  private sendWorkbook(res: Response, fileName: string, sheetName: string, rows: Record<string, unknown>[]) {
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(buffer);
  }

  @Post("/api/onboarding/workspace")
  createWorkspace(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.createWorkspace(req.userId, body);
  }

  @Post("/api/onboarding/org-and-project")
  createOrgAndProject(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.createOrgAndProject(req.userId, body);
  }

  @Get("/api/workspace")
  workspace(@Req() req: AuthenticatedRequest) {
    return this.legacy.workspace(req.userId);
  }

  @Get("/api/workspace/analytics")
  workspaceAnalytics() {
    return this.legacy.analytics();
  }

  @Get("/api/workspace/members")
  workspaceMembers(@Req() req: AuthenticatedRequest) {
    return this.legacy.workspaceMembers(req.userId);
  }

  @Post("/api/workspace/members")
  addWorkspaceMember(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.addWorkspaceMember(req.userId, body);
  }

  @Delete("/api/workspace/members/:userId")
  removeWorkspaceMember(@Req() req: AuthenticatedRequest, @Param("userId") userId: string) {
    return this.legacy.removeWorkspaceMember(req.userId, userId);
  }

  @Get("/api/workspace/project-access")
  async projectAccess(@Req() req: AuthenticatedRequest) {
    const projects = await this.legacy.listProjects(req.userId);
    const members = await this.legacy.workspaceMembers(req.userId);
    return { projects, members: members.map((m) => ({ ...m, projectRoles: {} })) };
  }

  @Put("/api/workspace/project-access")
  setProjectAccess(@Body() body: Record<string, any>) {
    return this.legacy.addProjectMember(body.projectId, { userId: body.userId, role: body.role });
  }

  @Delete("/api/workspace/project-access")
  removeProjectAccess(@Body() body: Record<string, any>) {
    return this.legacy.removeProjectMember(body.projectId, body.userId);
  }

  @Get("/api/workspace/ai-keys")
  aiKeys(@Req() req: AuthenticatedRequest) {
    return this.legacy.aiKeys(req.userId);
  }

  @Post("/api/workspace/ai-keys")
  createAiKey(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.createAiKey(req.userId, body);
  }

  @Delete("/api/workspace/ai-keys/:keyId")
  deleteAiKey(@Req() req: AuthenticatedRequest, @Param("keyId") keyId: string) {
    return this.legacy.deleteAiKey(req.userId, keyId);
  }

  @Post("/api/workspace/ai-keys/allocations")
  allocateAiKey(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.allocateAiKey(req.userId, body);
  }

  @Get("/api/workspace/invitations")
  invitations() {
    return [];
  }

  @Post("/api/workspace/invitations")
  createInvitation(@Body() body: Record<string, any>) {
    return { id: "local-invite", email: body.email, role: body.role || "member", expiresAt: null, createdAt: new Date().toISOString() };
  }

  @Delete("/api/workspace/invitations/:id")
  revokeInvitation() {}

  @Get("/api/invitations/:token")
  getInvitation(@Param("token") token: string) {
    return { id: token, status: "expired" };
  }

  @Post("/api/invitations/:token/accept")
  acceptInvitation() {
    return { accepted: false, organizationId: null, projectId: null };
  }

  @Get("/api/projects")
  listProjects(@Req() req: AuthenticatedRequest) {
    return this.legacy.listProjects(req.userId);
  }

  @Post("/api/projects")
  createProject(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.createProject(req.userId, body);
  }

  @Get("/api/projects/:id")
  getProject(@Param("id") id: string) {
    return this.legacy.getProject(id);
  }

  @Patch("/api/projects/:id")
  updateProject(@Param("id") id: string, @Body() body: Record<string, any>) {
    return this.legacy.updateProject(id, body);
  }

  @Delete("/api/projects/:id")
  deleteProject(@Param("id") id: string) {
    return this.legacy.deleteProject(id);
  }

  @Get("/api/projects/:id/members")
  projectMembers(@Param("id") id: string) {
    return this.legacy.projectMembers(id);
  }

  @Post("/api/projects/:id/members")
  addProjectMember(@Param("id") id: string, @Body() body: Record<string, any>) {
    return this.legacy.addProjectMember(id, body);
  }

  @Delete("/api/projects/:id/members/:userId")
  removeProjectMember(@Param("id") id: string, @Param("userId") userId: string) {
    return this.legacy.removeProjectMember(id, userId);
  }

  @Get("/api/projects/:id/apikeys")
  apiKeys() {
    return [];
  }

  @Post("/api/projects/:id/apikeys")
  createApiKey() {
    return { id: "local-api-key", token: "local-dev-token", createdAt: new Date().toISOString() };
  }

  @Delete("/api/projects/:id/apikeys/:keyId")
  revokeApiKey() {}

  @Get("/api/projects/:projectId/suites")
  listSuites(@Param("projectId") projectId: string) {
    return this.legacy.listSuites(projectId);
  }

  @Post("/api/projects/:projectId/suites")
  createSuite(@Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createSuite(projectId, body);
  }

  @Patch("/api/suites/:suiteId")
  updateSuite(@Param("suiteId") suiteId: string, @Body() body: Record<string, any>) {
    return this.legacy.updateSuite(suiteId, body);
  }

  @Delete("/api/suites/:suiteId")
  deleteSuite(@Param("suiteId") suiteId: string, @Query("mode") mode?: string) {
    return this.legacy.deleteSuite(suiteId, mode);
  }

  @Get("/api/projects/:projectId/testcases")
  async listTestCases(@Param("projectId") projectId: string, @Query() query: Record<string, any>, @Res() res: Response) {
    const result = await this.legacy.listTestCases(projectId, query);
    res.setHeader("X-Total-Count", String(result.total));
    res.json(result.rows);
  }

  @Post("/api/projects/:projectId/testcases")
  createTestCase(@Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createTestCase(projectId, body);
  }

  @Get("/api/projects/:projectId/testcases/linked-jira-keys")
  linkedJiraKeys(@Param("projectId") projectId: string) {
    return this.legacy.linkedJiraKeys(projectId);
  }

  @Get("/api/projects/:projectId/testcases/:testcaseId")
  getTestCase(@Param("testcaseId") testcaseId: string) {
    return this.legacy.getTestCase(testcaseId);
  }

  @Put("/api/projects/:projectId/testcases/:testcaseId")
  updateTestCase(@Param("testcaseId") testcaseId: string, @Body() body: Record<string, any>) {
    return this.legacy.updateTestCase(testcaseId, body);
  }

  @Delete("/api/projects/:projectId/testcases/:testcaseId")
  deleteTestCase(@Param("testcaseId") testcaseId: string) {
    return this.legacy.deleteTestCase(testcaseId);
  }

  @Post("/api/projects/:projectId/testcases/bulk-update")
  bulkUpdate(@Body() body: Record<string, any>) {
    return this.legacy.bulkUpdateTestCases(body);
  }

  @Post("/api/projects/:projectId/testcases/bulk-delete")
  bulkDelete(@Body() body: Record<string, any>) {
    return this.legacy.bulkDeleteTestCases(body.testcaseIds || []);
  }

  @Get("/api/projects/:projectId/plans")
  listPlans(@Param("projectId") projectId: string) {
    return this.legacy.listPlans(projectId);
  }

  @Post("/api/projects/:projectId/plans")
  createPlan(@Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createPlan(projectId, body);
  }

  @Get("/api/plans/:planId")
  getPlan(@Param("planId") planId: string) {
    return this.legacy.getPlan(planId);
  }

  @Patch("/api/plans/:planId")
  updatePlan(@Param("planId") planId: string, @Body() body: Record<string, any>) {
    return this.legacy.updatePlan(planId, body);
  }

  @Delete("/api/plans/:planId")
  deletePlan(@Param("planId") planId: string) {
    return this.legacy.deletePlan(planId);
  }

  @Get("/api/plans/:planId/items")
  planItems(@Param("planId") planId: string) {
    return this.legacy.planItems(planId);
  }

  @Post("/api/plans/:planId/items")
  addPlanItem(@Param("planId") planId: string, @Body() body: Record<string, any>) {
    return this.legacy.addPlanItem(planId, body);
  }

  @Delete("/api/plans/:planId/items/:itemId")
  removePlanItem(@Param("itemId") itemId: string) {
    return this.legacy.deletePlanItem(itemId);
  }

  @Get("/api/plans/:planId/runs")
  planRuns(@Param("planId") planId: string) {
    return this.legacy.planRuns(planId);
  }

  @Get("/api/plans/:planId/progress")
  planProgress(@Param("planId") planId: string) {
    return this.legacy.planProgress(planId);
  }

  @Get("/api/projects/:projectId/cycles")
  listCycles(@Param("projectId") projectId: string) {
    return this.legacy.listCycles(projectId);
  }

  @Post("/api/projects/:projectId/cycles")
  createCycle(@Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createCycle(projectId, body);
  }

  @Post("/api/projects/:projectId/cycles/from-plan")
  createCycleFromPlan(@Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createCycle(projectId, body);
  }

  @Post("/api/projects/:projectId/cycles/from-cases")
  createCycleFromCases(@Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createCycle(projectId, body);
  }

  @Get("/api/cycles/:cycleId")
  getCycle(@Param("cycleId") cycleId: string) {
    return this.legacy.getCycle(cycleId);
  }

  @Patch("/api/cycles/:cycleId")
  updateCycle(@Param("cycleId") cycleId: string, @Body() body: Record<string, any>) {
    return this.legacy.updateCycle(cycleId, body);
  }

  @Delete("/api/cycles/:cycleId")
  deleteCycle(@Param("cycleId") cycleId: string) {
    return this.legacy.deleteCycle(cycleId);
  }

  @Post("/api/cycles/:cycleId/testcases")
  addCycleCases(@Param("cycleId") cycleId: string, @Body() body: Record<string, any>) {
    return this.legacy.addCycleTestCases(cycleId, body);
  }

  @Delete("/api/cycles/:cycleId/testcases/:testcaseId")
  removeCycleCase(@Param("cycleId") cycleId: string, @Param("testcaseId") testcaseId: string) {
    return this.legacy.removeCycleTestCase(cycleId, testcaseId);
  }

  @Get("/api/cycles/:cycleId/executions")
  executions(@Param("cycleId") cycleId: string) {
    return this.legacy.executions(cycleId);
  }

  @Patch("/api/cycles/:cycleId/executions/:executionId")
  updateExecution(@Param("executionId") executionId: string, @Body() body: Record<string, any>) {
    return this.legacy.updateExecution(executionId, body);
  }

  @Post("/api/cycles/:cycleId/executions/bulk-assign")
  bulkAssign() {}

  @Post("/api/cycles/:cycleId/executions/bulk-status")
  bulkStatus() {}

  @Post("/api/cycles/:cycleId/share")
  shareCycle(@Param("cycleId") cycleId: string, @Body() body: Record<string, any>) {
    return this.legacy.shareCycle(cycleId, body);
  }

  @Get("/api/projects/:projectId/cycles/schedules")
  schedules() {
    return [];
  }

  @Post("/api/projects/:projectId/cycles/schedules")
  createSchedule(@Body() body: Record<string, any>) {
    return { id: "local-schedule", ...body };
  }

  @Patch("/api/cycles/schedules/:scheduleId")
  updateSchedule() {}

  @Delete("/api/cycles/schedules/:scheduleId")
  deleteSchedule() {}

  @Get("/api/public/shared-runs/:token")
  publicRun(@Param("token") token: string) {
    return this.legacy.publicCycle(token);
  }

  @Get("/api/public/shared-runs/:token/executions")
  publicExecutions(@Param("token") token: string) {
    return this.legacy.publicCycleExecutions(token);
  }

  @Get("/api/projects/:projectId/bugs")
  listBugs(@Param("projectId") projectId: string) {
    return this.legacy.listBugs(projectId);
  }

  @Post("/api/projects/:projectId/bugs")
  createBug(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createBug(projectId, req.userId, body);
  }

  @Get("/api/bugs/:bugId")
  getBug(@Param("bugId") bugId: string) {
    return this.legacy.getBug(bugId);
  }

  @Patch("/api/bugs/:bugId")
  updateBug(@Param("bugId") bugId: string, @Body() body: Record<string, any>) {
    return this.legacy.updateBug(bugId, body);
  }

  @Delete("/api/bugs/:bugId")
  deleteBug(@Param("bugId") bugId: string) {
    return this.legacy.deleteBug(bugId);
  }

  @Get("/api/projects/:projectId/testcases/export/csv")
  async exportCsv(@Param("projectId") projectId: string, @Res() res: Response) {
    const rows = await this.legacy.exportTestCases(projectId);
    const headers = ["externalId", "title", "description", "preconditions", "steps", "testData", "priority", "severity", "type", "status", "suite", "component"];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="testcases.csv"');
    res.send(this.rowsToCsv(headers, rows));
  }

  @Get("/api/projects/:projectId/testcases/export/xlsx")
  async exportXlsx(@Param("projectId") projectId: string, @Res() res: Response) {
    const rows = await this.legacy.exportTestCases(projectId);
    this.sendWorkbook(res, "testcases.xlsx", "Test Cases", rows);
  }

  @Get("/api/projects/:projectId/testcases/import/template")
  template(@Query("format") format: string | undefined, @Res() res: Response) {
    const rows = [
      {
        title: "Example login test",
        description: "Verify a valid user can sign in.",
        preconditions: "User account exists.",
        steps: "Open login page | Enter credentials | Submit form",
        testData: "user@example.com",
        priority: "P2",
        severity: "Medium",
        type: "Functional",
        status: "Draft",
        suite: "Authentication",
        component: "Login"
      }
    ];
    if (format === "xlsx") {
      this.sendWorkbook(res, "testcase-import-template.xlsx", "Test Cases", rows);
      return;
    }
    const headers = Object.keys(rows[0]);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="testcase-import-template.csv"');
    res.send(this.rowsToCsv(headers, rows));
  }

  @Post("/api/projects/:projectId/testcases/import/preview")
  previewImport() {
    return { uploadId: "local-upload", headers: [], previewRows: [], totalRows: 0 };
  }

  @Post("/api/projects/:projectId/testcases/import")
  executeImport() {
    return { imported: 0, errors: [] };
  }

  @Get("/api/cycles/:cycleId/export/csv")
  @Header("Content-Type", "text/csv")
  exportCycle() {
    return "externalId,title,status\n";
  }

  @Get("/api/projects/:projectId/analytics")
  projectAnalytics(@Param("projectId") projectId: string) {
    return this.legacy.analytics(projectId);
  }

  @Get("/api/cycles/:cycleId/report/summary")
  cycleSummary() {
    return { total: 0, passed: 0, failed: 0, blocked: 0, skipped: 0, untested: 0 };
  }

  @Get("/api/projects/:projectId/reports/execution")
  executionReport(@Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.executionReport(projectId, query);
  }

  @Get("/api/projects/:projectId/reports/requirement-matrix")
  matrix(@Param("projectId") projectId: string) {
    return this.legacy.requirementMatrix(projectId);
  }

  @Get("/api/projects/:projectId/reports/repository-summary")
  repositorySummary(@Param("projectId") projectId: string) {
    return this.legacy.repositorySummary(projectId);
  }

  @Post("/api/projects/:projectId/ai/generate-testcases")
  generateAi(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.aiGenerate(projectId, req.userId, body);
  }

  @Post("/api/projects/:projectId/ai/review-script")
  reviewScript() {
    return { status: "passed", summary: "", categories: [], validatedSteps: [] };
  }

  @Get("/api/projects/:projectId/ai/generation-history")
  aiHistory(@Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.aiHistory(projectId, query);
  }

  @Post("/api/projects/:projectId/ai/generation-history/:requestId/save")
  aiSave(@Param("projectId") projectId: string, @Param("requestId") requestId: string, @Body() body: Record<string, any>) {
    return this.legacy.aiSave(projectId, requestId, body);
  }

  @Get("/api/projects/:projectId/agents/zyra")
  zyraAgent(@Param("projectId") projectId: string) {
    return this.legacy.zyraAgent(projectId);
  }

  @Get("/api/projects/:projectId/agents/zyra/test")
  testZyraConnection(@Param("projectId") projectId: string) {
    return this.legacy.testZyraAiConnection(projectId);
  }

  @Patch("/api/projects/:projectId/agents/zyra/settings")
  updateZyraSettings(@Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.updateZyraSettings(projectId, body);
  }

  @Get("/api/projects/:projectId/agents/zyra/chat/sessions")
  zyraChatSessions(@Param("projectId") projectId: string) {
    return this.legacy.zyraChatSessions(projectId);
  }

  @Post("/api/projects/:projectId/agents/zyra/chat/sessions")
  createZyraChatSession(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createZyraChatSession(projectId, req.userId, body);
  }

  @Get("/api/projects/:projectId/agents/zyra/chat/sessions/:sessionId")
  zyraChatSession(@Param("projectId") projectId: string, @Param("sessionId") sessionId: string) {
    return this.legacy.zyraChatSession(projectId, sessionId);
  }

  @Post("/api/projects/:projectId/agents/zyra/chat/sessions/:sessionId/messages")
  sendZyraChatMessage(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("sessionId") sessionId: string,
    @Body() body: Record<string, any>
  ) {
    return this.legacy.sendZyraChatMessage(projectId, req.userId, sessionId, body);
  }

  @Post("/api/projects/:projectId/agents/zyra/tasks")
  createZyraTask(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.aiGenerate(projectId, req.userId, body);
  }

  @Get("/api/projects/:projectId/agents/zyra/tasks/:taskId")
  getZyraTask(@Param("projectId") projectId: string, @Param("taskId") taskId: string) {
    return this.legacy.zyraTask(projectId, taskId);
  }

  @Post("/api/projects/:projectId/agents/zyra/tasks/:taskId/feedback")
  feedbackZyraTask(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("taskId") taskId: string,
    @Body() body: Record<string, any>
  ) {
    return this.legacy.zyraFeedback(projectId, req.userId, taskId, body);
  }

  @Delete("/api/projects/:projectId/agents/zyra/tasks/:taskId/drafts/:draftIndex")
  deleteZyraDraft(@Param("projectId") projectId: string, @Param("taskId") taskId: string, @Param("draftIndex") draftIndex: string) {
    return this.legacy.zyraDeleteDraft(projectId, taskId, Number(draftIndex));
  }

  @Post("/api/projects/:projectId/agents/zyra/tasks/:taskId/close")
  closeZyraTask(@Param("projectId") projectId: string, @Param("taskId") taskId: string) {
    return this.legacy.zyraCloseTask(projectId, taskId);
  }

  @Post("/api/projects/:projectId/agents/zyra/tasks/:taskId/save")
  saveZyraTask(@Param("projectId") projectId: string, @Param("taskId") taskId: string, @Body() body: Record<string, any>) {
    return this.legacy.zyraSave(projectId, taskId, body);
  }

  @Get("/api/projects/:projectId/knowledge-base")
  knowledge(@Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.listKnowledge(projectId, query);
  }

  @Post("/api/projects/:projectId/knowledge-base")
  createKnowledge(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createKnowledge(projectId, req.userId, body);
  }

  @Post("/api/projects/:projectId/knowledge-base/upload")
  uploadKnowledge() {
    return { error: "File uploads are not enabled in this endpoint yet" };
  }

  @Get("/api/projects/:projectId/knowledge-base/:itemId")
  getKnowledge(@Param("itemId") itemId: string) {
    return this.legacy.getKnowledge(itemId);
  }

  @Patch("/api/projects/:projectId/knowledge-base/:itemId")
  updateKnowledge(@Param("itemId") itemId: string, @Body() body: Record<string, any>) {
    return this.legacy.updateKnowledge(itemId, body);
  }

  @Delete("/api/projects/:projectId/knowledge-base/:itemId")
  deleteKnowledge(@Param("itemId") itemId: string) {
    return this.legacy.deleteKnowledge(itemId);
  }

  @Get("/api/projects/:projectId/knowledge-base/:itemId/file")
  knowledgeFile() {
    return {};
  }

  @Get("/api/projects/:projectId/jira/auth-url")
  jiraAuth(@Param("projectId") projectId: string) {
    return this.legacy.jiraAuthUrl(projectId);
  }

  @Get("/api/projects/:projectId/jira/config")
  jiraConfig(@Param("projectId") projectId: string) {
    return this.legacy.jiraConfigStatus(projectId);
  }

  @Patch("/api/projects/:projectId/jira/config")
  updateJiraConfig(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.updateJiraConfig(projectId, req.userId, body);
  }

  @Post("/api/projects/:projectId/jira/callback")
  jiraCallback(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.jiraCallback(projectId, req.userId, body);
  }

  @Get("/api/projects/:projectId/jira/status")
  jiraStatus(@Param("projectId") projectId: string) {
    return this.legacy.jiraStatus(projectId);
  }

  @Delete("/api/projects/:projectId/jira/disconnect")
  jiraDisconnect(@Param("projectId") projectId: string) {
    return this.legacy.jiraDisconnect(projectId);
  }

  @Get("/api/projects/:projectId/jira/projects")
  jiraProjects(@Param("projectId") projectId: string) {
    return this.legacy.jiraProjects(projectId);
  }

  @Post("/api/projects/:projectId/jira/projects")
  connectJiraProjects(@Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.connectJiraProjects(projectId, body);
  }

  @Post("/api/projects/:projectId/jira/sync")
  syncJira(@Param("projectId") projectId: string) {
    return this.legacy.syncJira(projectId);
  }

  @Get("/api/projects/:projectId/jira/tickets")
  jiraTickets(@Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.jiraTickets(projectId, query);
  }

  @Post("/api/projects/:projectId/jira/comment")
  jiraComment(@Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.jiraComment(projectId, body);
  }

  @Get("/api/projects/:projectId/activity")
  activity(@Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.listActivity(projectId, query);
  }

  @Get("/api/notifications")
  notifications() {
    return [];
  }

  @Post("/api/notifications/:id/read")
  readNotification() {}

  @Get("/api/admin/customers")
  customers() {
    return this.legacy.adminCustomers();
  }

  @Get("/api/admin/admins")
  admins() {
    return this.legacy.adminList();
  }

  @Get("/api/branding")
  branding() {
    return this.legacy.publicBranding();
  }

  @Get("/api/admin/branding")
  adminBranding(@Req() req: AuthenticatedRequest) {
    return this.legacy.adminBranding(req.userId);
  }

  @Patch("/api/admin/branding")
  updateAdminBranding(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.updateAdminBranding(req.userId, body);
  }

  @Post("/api/admin/admins")
  addAdmin(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.addAdmin(body, req.userId);
  }

  @Delete("/api/admin/admins/:adminId")
  removeAdmin(@Param("adminId") adminId: string) {
    return this.legacy.deleteAdmin(adminId);
  }

  @Get("/api/projects/:projectId/tesbo-reports/runs")
  tesboRuns() {
    return [];
  }

  @Get("/api/projects/:projectId/tesbo-reports/specs")
  tesboSpecs() {
    return [];
  }

  @Get("/api/projects/:projectId/tesbo-reports/tests")
  tesboTests() {
    return [];
  }

  @Get("/api/projects/:projectId/tesbo-reports/analytics")
  tesboAnalytics() {
    return { totalRuns: 0, totalTests: 0, passRate: 0, byStatus: {}, runsByDay: [] };
  }

  @Get("/api/projects/:projectId/tesbo-reports/alerts")
  tesboAlerts() {
    return [];
  }

  @Get("/api/projects/:projectId/tesbo-reports/settings")
  tesboSettings() {
    return { keepTrace: true, traceRetentionDays: 14, ingestionApiKey: "", alertsEnabled: false, shareByDefault: false };
  }
}
