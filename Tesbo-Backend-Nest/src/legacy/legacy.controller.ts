import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  NotImplementedException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseInterceptors
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import ExcelJS from "exceljs";
import { AuthenticatedRequest } from "../common/request.types";
import { LegacyService } from "./legacy.service";
import { CustomFieldsService } from "../custom-fields/custom-fields.service";

const TESTCASE_EXPORT_BASE_HEADERS = [
  "externalId",
  "title",
  "description",
  "preconditions",
  "steps",
  "testData",
  "priority",
  "severity",
  "type",
  "status",
  "suite",
  "component"
];

/*
 * Reports & Insights export.
 *
 * Basecamp 10218723531 ("Reports & Insights > Export buttons are not working"): the button carried
 * no onClick at all — title="Coming soon", cursor-not-allowed, never wired to anything. It is a
 * real export now, one per report view, because the screen already holds six different reports and
 * exporting "the reports" without saying which one is meaningless.
 *
 * Every view reuses the same `*ForUser` service method the screen itself calls, so the numbers in
 * the file are the numbers on the screen and authorization is the existing project-membership check
 * rather than a second implementation of it.
 *
 * Two shapes come out of this. `execution` and `matrix` are already row-per-record tables and
 * export as themselves. The other four are dashboards — a mix of scalars and several unrelated
 * series — so they export in long form (section, label, metric, value), which stays one parseable
 * table instead of stacked mini-tables with conflicting headers.
 */
const REPORT_EXPORT_VIEWS = ["overview", "execution", "matrix", "repository", "insights", "trends"] as const;
type ReportExportView = (typeof REPORT_EXPORT_VIEWS)[number];

const REPORT_LONG_HEADERS = ["section", "label", "metric", "value"];

const REPORT_EXECUTION_HEADERS = [
  "groupName",
  "Passed",
  "Failed",
  "Blocked",
  "Skipped",
  "Untested",
  "Retest",
  "total"
];

const REPORT_MATRIX_HEADERS = [
  "externalId",
  "testcaseTitle",
  "priority",
  "testcaseStatus",
  "suiteName",
  "runName",
  "runStatus",
  "executionStatus",
  "executedAt",
  "bugTitle",
  "bugStatus",
  "bugUrl"
];

const REPORT_VIEW_SHEET_NAMES: Record<ReportExportView, string> = {
  overview: "Overview",
  execution: "Execution Report",
  matrix: "Traceability",
  repository: "Repository",
  insights: "AI Insights",
  trends: "Trends"
};

@Controller()
export class LegacyController {
  constructor(
    private readonly legacy: LegacyService,
    private readonly customFields: CustomFieldsService
  ) {}

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

  // exceljs writes whatever it is handed, and a plain object or an array would land as a formula or
  // rich-text cell rather than a value. Numbers, booleans and dates have to stay typed — a real 0
  // must survive as the number 0 (see longRow) — so only those pass through untouched; null and
  // undefined become an empty cell, and anything else is stringified.
  private cellValue(value: unknown): ExcelJS.CellValue {
    if (value == null) return null;
    if (typeof value === "number" || typeof value === "boolean" || value instanceof Date) return value;
    return String(value);
  }

  private async sendWorkbook(
    res: Response,
    fileName: string,
    sheetName: string,
    rows: Record<string, unknown>[],
    headers?: string[]
  ) {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(sheetName);
    // The header list is passed explicitly wherever the caller knows it: deriving the columns from
    // the first row's keys means exporting a project with no test cases produces a workbook with no
    // header row at all — a blank sheet with nothing to fill in, while the CSV export of the same
    // project still emits its headers.
    const columns = headers ?? Object.keys(rows[0] ?? {});
    worksheet.addRow(columns);
    for (const row of rows) {
      worksheet.addRow(columns.map((column) => this.cellValue(row[column])));
    }
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(Buffer.from(buffer));
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

  @Get("/api/workspaces")
  listWorkspaces(@Req() req: AuthenticatedRequest) {
    return this.legacy.listWorkspaces(req.userId);
  }

  @Post("/api/workspaces")
  createAdditionalWorkspace(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.createWorkspace(req.userId, body);
  }

  @Post("/api/workspaces/:id/switch")
  switchWorkspace(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    return this.legacy.switchWorkspace(req.userId, id);
  }

  @Patch("/api/workspace")
  updateWorkspace(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.updateWorkspace(req.userId, body);
  }

  @Get("/api/workspace/analytics")
  async workspaceAnalytics(@Req() req: AuthenticatedRequest) {
    const workspace = await this.legacy.workspace(req.userId);
    // The caller is passed through so the workspace dashboard can be narrowed to the projects they can
    // actually reach — see analytics(). Basecamp 10199551447.
    return this.legacy.analytics(undefined, workspace.id, req.userId);
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
  projectAccess(@Req() req: AuthenticatedRequest) {
    return this.legacy.workspaceProjectAccess(req.userId);
  }

  @Put("/api/workspace/project-access")
  setProjectAccess(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.addProjectMember(req.userId, body.projectId, { userId: body.userId, role: body.role });
  }

  @Delete("/api/workspace/project-access")
  removeProjectAccess(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.removeProjectMember(req.userId, body.projectId, body.userId);
  }

  @Get("/api/workspace/ai-keys")
  aiKeys(@Req() req: AuthenticatedRequest) {
    return this.legacy.aiKeys(req.userId);
  }

  @Post("/api/workspace/ai-keys")
  createAiKey(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.createAiKey(req.userId, body);
  }

  @Get("/api/workspace/ai-providers")
  aiProviders() {
    return this.legacy.listAiProviders();
  }

  // POST, not GET: the settings form calls this with an unsaved API key in the body,
  // which must not end up in a URL, a proxy log, or the browser history.
  @Post("/api/workspace/ai-keys/models")
  listProviderModels(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.listProviderModels(req.userId, body);
  }

  @Delete("/api/workspace/ai-keys/:keyId")
  deleteAiKey(@Req() req: AuthenticatedRequest, @Param("keyId") keyId: string) {
    return this.legacy.deleteAiKey(req.userId, keyId);
  }

  @Post("/api/workspace/ai-keys/allocations")
  allocateAiKey(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.allocateAiKey(req.userId, body);
  }

  @Post("/api/workspace/members/role")
  changeWorkspaceMemberRole(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.changeWorkspaceMemberRole(req.userId, body.userId, body.role);
  }

  @Get("/api/workspace/invitations")
  listInvitations(@Req() req: AuthenticatedRequest) {
    return this.legacy.listInvitations(req.userId);
  }

  @Post("/api/workspace/invitations")
  createInvitation(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.createInvitation(req.userId, body);
  }

  @Delete("/api/workspace/invitations/:id")
  cancelInvitation(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    return this.legacy.cancelInvitation(req.userId, id);
  }

  @Post("/api/workspace/invitations/:id/resend")
  resendInvitation(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    return this.legacy.resendInvitation(req.userId, id);
  }

  @Get("/api/invitations/:token")
  getInvitation(@Param("token") token: string) {
    return this.legacy.getInvitationByToken(token);
  }

  @Post("/api/invitations/:token/accept")
  acceptInvitation(@Req() req: AuthenticatedRequest, @Param("token") token: string) {
    return this.legacy.acceptInvitation(req.userId, token);
  }

  @Post("/api/invitations/:token/register")
  registerFromInvitation(@Param("token") token: string, @Body() body: Record<string, any>) {
    return this.legacy.registerFromInvitation(token, body);
  }

  @Get("/api/projects")
  listProjects(@Req() req: AuthenticatedRequest) {
    return this.legacy.listProjects(req.userId);
  }

  @Post("/api/projects")
  createProject(@Req() req: AuthenticatedRequest, @Body() body: Record<string, any>) {
    return this.legacy.createProject(req.userId, body);
  }

  // Declared above `/api/projects/:id` on purpose — Nest matches in declaration order, so the
  // parameterised route would otherwise capture "overview" as a project id and 404.
  @Get("/api/projects/overview")
  projectsOverview(@Req() req: AuthenticatedRequest) {
    return this.legacy.projectsOverview(req.userId);
  }

  @Get("/api/projects/:id")
  getProject(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    return this.legacy.getProjectForUser(req.userId, id);
  }

  @Patch("/api/projects/:id")
  updateProject(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: Record<string, any>) {
    return this.legacy.updateProjectForUser(req.userId, id, body);
  }

  @Delete("/api/projects/:id")
  deleteProject(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    return this.legacy.deleteProjectForUser(req.userId, id);
  }

  @Get("/api/projects/:id/members")
  projectMembers(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    return this.legacy.projectMembers(req.userId, id);
  }

  @Post("/api/projects/:id/members")
  addProjectMember(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: Record<string, any>) {
    return this.legacy.addProjectMember(req.userId, id, body);
  }

  @Delete("/api/projects/:id/members/:userId")
  removeProjectMember(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Param("userId") userId: string) {
    return this.legacy.removeProjectMember(req.userId, id, userId);
  }

  @Get("/api/projects/:id/apikeys")
  apiKeys(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    return this.legacy.listApiKeys(req.userId, id);
  }

  @Post("/api/projects/:id/apikeys")
  createApiKey(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() body: Record<string, any>) {
    return this.legacy.createApiKey(req.userId, id, body);
  }

  @Delete("/api/projects/:id/apikeys/:keyId")
  revokeApiKey(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Param("keyId") keyId: string) {
    return this.legacy.revokeApiKey(req.userId, id, keyId);
  }

  @Get("/api/projects/:projectId/suites")
  listSuites(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.listSuitesForUser(req.userId, projectId);
  }

  @Post("/api/projects/:projectId/suites")
  createSuite(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createSuiteForUser(req.userId, projectId, body);
  }

  @Patch("/api/suites/:suiteId")
  updateSuite(@Req() req: AuthenticatedRequest, @Param("suiteId") suiteId: string, @Body() body: Record<string, any>) {
    return this.legacy.updateSuite(req.userId, suiteId, body);
  }

  @Delete("/api/suites/:suiteId")
  deleteSuite(@Req() req: AuthenticatedRequest, @Param("suiteId") suiteId: string, @Query("mode") mode?: string) {
    return this.legacy.deleteSuite(req.userId, suiteId, mode);
  }

  @Get("/api/projects/:projectId/testcases")
  async listTestCases(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Query() query: Record<string, any>,
    @Res() res: Response
  ) {
    const result = await this.legacy.listTestCasesForUser(req.userId, projectId, query);
    res.setHeader("X-Total-Count", String(result.total));
    res.json(result.rows);
  }

  @Post("/api/projects/:projectId/testcases")
  createTestCase(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createTestCaseForUser(req.userId, projectId, body);
  }

  @Get("/api/projects/:projectId/testcases/linked-jira-keys")
  linkedJiraKeys(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.linkedJiraKeys(projectId, req.userId);
  }

  @Get("/api/projects/:projectId/testcases/linked-linear-keys")
  linkedLinearKeys(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.linkedLinearKeys(projectId, req.userId);
  }

  @Get("/api/projects/:projectId/testcases/:testcaseId")
  getTestCase(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("testcaseId") testcaseId: string
  ) {
    return this.legacy.getTestCaseForUser(req.userId, projectId, testcaseId);
  }

  @Put("/api/projects/:projectId/testcases/:testcaseId")
  updateTestCase(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("testcaseId") testcaseId: string,
    @Body() body: Record<string, any>
  ) {
    return this.legacy.updateTestCaseForUser(req.userId, projectId, testcaseId, body);
  }

  @Delete("/api/projects/:projectId/testcases/:testcaseId")
  deleteTestCase(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("testcaseId") testcaseId: string
  ) {
    return this.legacy.deleteTestCaseForUser(req.userId, projectId, testcaseId);
  }

  @Post("/api/projects/:projectId/testcases/:testcaseId/duplicate")
  duplicateTestCase(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("testcaseId") testcaseId: string
  ) {
    return this.legacy.duplicateTestCaseForUser(req.userId, projectId, testcaseId);
  }

  @Post("/api/projects/:projectId/testcases/bulk-create")
  bulkCreate(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.bulkCreateTestCases(projectId, req.userId, body);
  }

  @Post("/api/projects/:projectId/testcases/bulk-update")
  bulkUpdate(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.bulkUpdateTestCases(projectId, req.userId, body);
  }

  @Post("/api/projects/:projectId/testcases/bulk-delete")
  bulkDelete(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.bulkDeleteTestCases(projectId, req.userId, body.testcaseIds || []);
  }

  @Post("/api/projects/:projectId/testcases/import")
  importTestCases(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.importTestCases(req.userId, projectId, body);
  }

  @Get("/api/projects/:projectId/plans")
  listPlans(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.listPlansForUser(req.userId, projectId);
  }

  @Post("/api/projects/:projectId/plans")
  createPlan(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createPlan(req.userId, projectId, body);
  }

  @Get("/api/plans/:planId")
  getPlan(@Req() req: AuthenticatedRequest, @Param("planId") planId: string) {
    return this.legacy.getPlan(req.userId, planId);
  }

  @Patch("/api/plans/:planId")
  updatePlan(@Req() req: AuthenticatedRequest, @Param("planId") planId: string, @Body() body: Record<string, any>) {
    return this.legacy.updatePlan(req.userId, planId, body);
  }

  @Delete("/api/plans/:planId")
  deletePlan(@Req() req: AuthenticatedRequest, @Param("planId") planId: string) {
    return this.legacy.deletePlan(req.userId, planId);
  }

  @Get("/api/plans/:planId/items")
  planItems(@Req() req: AuthenticatedRequest, @Param("planId") planId: string) {
    return this.legacy.planItems(req.userId, planId);
  }

  @Post("/api/plans/:planId/items")
  addPlanItem(@Req() req: AuthenticatedRequest, @Param("planId") planId: string, @Body() body: Record<string, any>) {
    return this.legacy.addPlanItem(req.userId, planId, body);
  }

  @Delete("/api/plans/:planId/items/:itemId")
  removePlanItem(
    @Req() req: AuthenticatedRequest,
    @Param("planId") planId: string,
    @Param("itemId") itemId: string
  ) {
    return this.legacy.deletePlanItem(req.userId, planId, itemId);
  }

  @Get("/api/plans/:planId/runs")
  planRuns(@Req() req: AuthenticatedRequest, @Param("planId") planId: string) {
    return this.legacy.planRuns(req.userId, planId);
  }

  @Get("/api/plans/:planId/progress")
  planProgress(@Req() req: AuthenticatedRequest, @Param("planId") planId: string) {
    return this.legacy.planProgress(req.userId, planId);
  }

  @Get("/api/projects/:projectId/cycles")
  listCycles(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.listCyclesForUser(req.userId, projectId);
  }

  @Post("/api/projects/:projectId/cycles")
  createCycle(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createCycleForUser(req.userId, projectId, body);
  }

  @Post("/api/projects/:projectId/cycles/from-plan")
  createCycleFromPlan(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createCycleForUser(req.userId, projectId, body);
  }

  @Post("/api/projects/:projectId/cycles/from-cases")
  createCycleFromCases(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createCycleForUser(req.userId, projectId, body);
  }

  @Get("/api/cycles/:cycleId")
  getCycle(@Req() req: AuthenticatedRequest, @Param("cycleId") cycleId: string) {
    return this.legacy.getCycle(cycleId, req.userId);
  }

  @Patch("/api/cycles/:cycleId")
  updateCycle(@Req() req: AuthenticatedRequest, @Param("cycleId") cycleId: string, @Body() body: Record<string, any>) {
    return this.legacy.updateCycle(cycleId, req.userId, body);
  }

  @Delete("/api/cycles/:cycleId")
  deleteCycle(@Req() req: AuthenticatedRequest, @Param("cycleId") cycleId: string) {
    return this.legacy.deleteCycle(cycleId, req.userId);
  }

  @Post("/api/cycles/:cycleId/testcases")
  addCycleCases(@Req() req: AuthenticatedRequest, @Param("cycleId") cycleId: string, @Body() body: Record<string, any>) {
    return this.legacy.addCycleTestCases(cycleId, req.userId, body);
  }

  // Mirrors /api/projects/:projectId/testcases/bulk-delete: POST (not DELETE) so the id list
  // travels in a body, which no proxy strips the way it can from a DELETE.
  @Post("/api/cycles/:cycleId/testcases/bulk-delete")
  removeCycleCases(@Req() req: AuthenticatedRequest, @Param("cycleId") cycleId: string, @Body() body: Record<string, any>) {
    return this.legacy.removeCycleTestCases(cycleId, req.userId, body);
  }

  @Delete("/api/cycles/:cycleId/testcases/:testcaseId")
  removeCycleCase(@Req() req: AuthenticatedRequest, @Param("cycleId") cycleId: string, @Param("testcaseId") testcaseId: string) {
    return this.legacy.removeCycleTestCase(cycleId, req.userId, testcaseId);
  }

  @Get("/api/cycles/:cycleId/executions")
  executions(@Req() req: AuthenticatedRequest, @Param("cycleId") cycleId: string) {
    return this.legacy.executionsForUser(cycleId, req.userId);
  }

  @Patch("/api/cycles/:cycleId/executions/:executionId")
  updateExecution(@Req() req: AuthenticatedRequest, @Param("executionId") executionId: string, @Body() body: Record<string, any>) {
    return this.legacy.updateExecution(executionId, req.userId, body);
  }

  @Post("/api/cycles/:cycleId/executions/:executionId/attachments")
  @UseInterceptors(FilesInterceptor("files", 10, { limits: { fileSize: LegacyService.KB_MAX_UPLOAD_SIZE } }))
  uploadExecutionAttachments(
    @Req() req: AuthenticatedRequest,
    @Param("cycleId") cycleId: string,
    @Param("executionId") executionId: string,
    @UploadedFiles() files: Array<{ buffer: Buffer; originalname: string; mimetype: string; size: number }>
  ) {
    return this.legacy.uploadExecutionAttachments(cycleId, req.userId, executionId, files);
  }

  @Get("/api/cycles/:cycleId/executions/:executionId/attachments")
  listExecutionAttachments(
    @Req() req: AuthenticatedRequest,
    @Param("cycleId") cycleId: string,
    @Param("executionId") executionId: string
  ) {
    return this.legacy.listExecutionAttachments(cycleId, req.userId, executionId);
  }

  /**
   * Download (or, for an image/video, render) one evidence file from a run's result.
   *
   * The list endpoint above has existed without this one, so evidence has been storable and
   * listable but not retrievable — see getExecutionAttachmentAccess. `?inline=1` is a request, not
   * a guarantee: the service refuses inline for anything that is not an image or a video, so a
   * trace .zip or a log is always a download.
   */
  @Get("/api/cycles/:cycleId/executions/:executionId/attachments/:attachmentId/download")
  async downloadExecutionAttachment(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Param("cycleId") cycleId: string,
    @Param("executionId") executionId: string,
    @Param("attachmentId") attachmentId: string,
    @Query("inline") inline?: string
  ) {
    const access = await this.legacy.getExecutionAttachmentAccess(
      cycleId,
      req.userId,
      executionId,
      attachmentId,
      inline === "1" || inline === "true"
    );
    if ("redirectUrl" in access) return res.redirect(302, access.redirectUrl);
    res.setHeader("Content-Type", access.mimeType);
    res.setHeader(
      "Content-Disposition",
      `${access.inline ? "inline" : "attachment"}; filename="${encodeURIComponent(access.originalFileName)}"`
    );
    if ("buffer" in access && access.buffer) return res.send(access.buffer);
    if ("localPath" in access && access.localPath) return res.sendFile(access.localPath);
    throw new Error("Attachment content unavailable");
  }

  /**
   * Mints a short-lived link the embedded Playwright trace viewer can read.
   *
   * The viewer is trace.playwright.dev running inside an iframe: it fetches the .zip itself, from
   * the browser, cross-origin and without credentials, so it cannot use the download route above.
   * This hands back a signed token instead; /api/public/trace/:token below is what redeems it.
   */
  @Get("/api/cycles/:cycleId/executions/:executionId/attachments/:attachmentId/trace-link")
  createExecutionTraceLink(
    @Req() req: AuthenticatedRequest,
    @Param("cycleId") cycleId: string,
    @Param("executionId") executionId: string,
    @Param("attachmentId") attachmentId: string
  ) {
    return this.legacy.createExecutionTraceLink(cycleId, req.userId, executionId, attachmentId);
  }

  /**
   * Serves one trace archive to a holder of a valid link. Unauthenticated by design — see
   * createExecutionTraceLink in the service for why, and for what keeps the grant narrow.
   *
   * The bytes are streamed from storage rather than redirected to a presigned URL: the fetch comes
   * from a third-party origin, so the response needs CORS headers we control, and a private bucket
   * has none. Evidence is capped at MAX_EVIDENCE_FILE_SIZE (25 MB by default), so buffering one
   * trace is bounded.
   */
  @Get("/api/public/trace/:token")
  async publicTrace(@Res() res: Response, @Param("token") token: string) {
    const trace = await this.legacy.getPublicTraceContent(token);
    // The viewer is a fixed, known origin, so it is named rather than wildcarded. No credentials
    // are involved either way — the token is the authorization.
    res.setHeader("Access-Control-Allow-Origin", "https://trace.playwright.dev");
    res.setHeader("Vary", "Origin");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Content-Type", "application/zip");
    // attachment, never inline: nothing served from this route may be rendered by a browser.
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(trace.fileName)}"`);
    res.setHeader("Cache-Control", "private, no-store");
    return res.send(trace.buffer);
  }

  @Post("/api/cycles/:cycleId/executions/bulk-assign")
  bulkAssign(@Req() req: AuthenticatedRequest, @Param("cycleId") cycleId: string, @Body() body: Record<string, any>) {
    return this.legacy.bulkAssignExecutions(cycleId, req.userId, body);
  }

  @Post("/api/cycles/:cycleId/executions/bulk-status")
  bulkStatus(@Req() req: AuthenticatedRequest, @Param("cycleId") cycleId: string, @Body() body: Record<string, any>) {
    return this.legacy.bulkUpdateExecutionStatus(cycleId, req.userId, body);
  }

  @Post("/api/cycles/:cycleId/share")
  shareCycle(@Req() req: AuthenticatedRequest, @Param("cycleId") cycleId: string, @Body() body: Record<string, any>) {
    return this.legacy.shareCycle(cycleId, req.userId, body);
  }

  /*
   * Scheduled runs are NOT IMPLEMENTED. There is no schedules table and no runner; these four routes
   * were stubs that answered 2xx — createSchedule handed back `{ id: "local-schedule", ...body }`
   * without storing anything, and the list, update and delete routes did nothing at all. A schedule
   * the user created, was told about, and can never see again is worse than a feature that says it
   * isn't there.
   *
   * Implementing it is a feature (a cron parser, a scheduler, a runner), not a bug fix, so it is left
   * out and recorded in docs/e2e-coverage-waves.md — see the red EXO-A-07/08/10 in
   * e2e/api/execution-ops.spec.ts. What is fixed here is the part that is unambiguous: they no longer
   * answer a caller with no session or no access to the project, and creating one no longer claims
   * success. 501 is the honest status for "the route exists, the feature does not".
   */
  @Get("/api/projects/:projectId/cycles/schedules")
  async schedules(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    await this.legacy.requireProjectAccess(req.userId, projectId);
    return [];
  }

  @Post("/api/projects/:projectId/cycles/schedules")
  async createSchedule(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Body() body: Record<string, any>
  ) {
    await this.legacy.requireProjectAccess(req.userId, projectId);
    throw new NotImplementedException({ error: "Scheduled runs are not available yet" });
  }

  @Patch("/api/cycles/schedules/:scheduleId")
  async updateSchedule(@Req() req: AuthenticatedRequest, @Param("scheduleId") scheduleId: string) {
    await this.legacy.requireSession(req.userId);
    throw new NotImplementedException({ error: "Scheduled runs are not available yet" });
  }

  @Delete("/api/cycles/schedules/:scheduleId")
  async deleteSchedule(@Req() req: AuthenticatedRequest, @Param("scheduleId") scheduleId: string) {
    await this.legacy.requireSession(req.userId);
    throw new NotImplementedException({ error: "Scheduled runs are not available yet" });
  }

  @Get("/api/public/shared-runs/:token")
  publicRun(@Param("token") token: string) {
    return this.legacy.publicCycle(token);
  }

  @Get("/api/public/shared-runs/:token/executions")
  publicExecutions(@Param("token") token: string) {
    return this.legacy.publicCycleExecutions(token);
  }

  @Get("/api/projects/:projectId/bugs")
  listBugs(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.listBugsForUser(req.userId, projectId, query);
  }

  @Post("/api/projects/:projectId/bugs")
  createBug(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createBug(projectId, req.userId, body);
  }

  @Get("/api/bugs/:bugId")
  getBug(@Req() req: AuthenticatedRequest, @Param("bugId") bugId: string) {
    return this.legacy.getBugForUser(req.userId, bugId);
  }

  @Patch("/api/bugs/:bugId")
  updateBug(@Req() req: AuthenticatedRequest, @Param("bugId") bugId: string, @Body() body: Record<string, any>) {
    return this.legacy.updateBug(req.userId, bugId, body);
  }

  @Delete("/api/bugs/:bugId")
  deleteBug(@Req() req: AuthenticatedRequest, @Param("bugId") bugId: string) {
    return this.legacy.deleteBug(req.userId, bugId);
  }

  @Post("/api/bugs/:bugId/links")
  addBugLink(@Req() req: AuthenticatedRequest, @Param("bugId") bugId: string, @Body() body: Record<string, any>) {
    return this.legacy.addBugLink(req.userId, bugId, body);
  }

  @Delete("/api/bugs/:bugId/links/:linkId")
  removeBugLink(@Req() req: AuthenticatedRequest, @Param("bugId") bugId: string, @Param("linkId") linkId: string) {
    return this.legacy.removeBugLink(req.userId, bugId, linkId);
  }

  @Post("/api/projects/:projectId/bugs/:bugId/attachments")
  @UseInterceptors(FilesInterceptor("files", 10, { limits: { fileSize: LegacyService.KB_MAX_UPLOAD_SIZE } }))
  uploadBugAttachments(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("bugId") bugId: string,
    @UploadedFiles() files: Array<{ buffer: Buffer; originalname: string; mimetype: string; size: number }>
  ) {
    return this.legacy.uploadBugAttachments(projectId, req.userId, bugId, files);
  }

  @Get("/api/projects/:projectId/bugs/attachments/:attachmentId/download")
  async downloadBugAttachment(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Param("projectId") projectId: string,
    @Param("attachmentId") attachmentId: string
  ) {
    const access = await this.legacy.getBugAttachmentAccess(projectId, req.userId, attachmentId, false);
    if ("redirectUrl" in access) return res.redirect(302, access.redirectUrl);
    res.setHeader("Content-Type", access.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(access.originalFileName)}"`);
    if ("buffer" in access && access.buffer) return res.send(access.buffer);
    if ("localPath" in access && access.localPath) return res.sendFile(access.localPath);
    throw new Error("Attachment content unavailable");
  }

  @Delete("/api/bugs/attachments/:attachmentId")
  deleteBugAttachment(@Req() req: AuthenticatedRequest, @Param("attachmentId") attachmentId: string) {
    return this.legacy.deleteBugAttachment(attachmentId, req.userId);
  }

  @Get("/api/projects/:projectId/testcases/export/csv")
  async exportCsv(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Res() res: Response) {
    const definitions = await this.customFields.listActiveDefinitionsForColumns(req.userId, projectId);
    const rows = await this.legacy.exportTestCases(projectId, definitions);
    const headers = [...TESTCASE_EXPORT_BASE_HEADERS, ...definitions.map((d) => `cf_${d.key}`)];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="testcases.csv"');
    res.send(this.rowsToCsv(headers, rows));
  }

  @Get("/api/projects/:projectId/testcases/export/xlsx")
  async exportXlsx(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Res() res: Response) {
    const definitions = await this.customFields.listActiveDefinitionsForColumns(req.userId, projectId);
    const rows = await this.legacy.exportTestCases(projectId, definitions);
    const headers = [...TESTCASE_EXPORT_BASE_HEADERS, ...definitions.map((d) => `cf_${d.key}`)];
    await this.sendWorkbook(res, "testcases.xlsx", "Test Cases", rows, headers);
  }

  @Get("/api/projects/:projectId/testcases/import/template")
  async template(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Query("format") format: string | undefined,
    @Res() res: Response
  ) {
    // The payload is a constant, but the route is project-scoped and only ever linked to from a
    // signed-in screen. Authorizing it keeps it consistent with every other route under
    // /api/projects/:id — it was the one that answered with no session, and that served the same
    // 200 for a project id that doesn't exist.
    await this.legacy.requireProjectAccess(req.userId, projectId);
    const rows = [
      {
        title: "Example login test",
        description: "Verify a valid user can sign in.",
        preconditions: "User account exists.",
        postconditions: "User lands on the dashboard with an active session.",
        // "action => expected result" per step, separated by " | " — the expected result after
        // "=>" is optional but importing it this way carries it into each step's Expected Result.
        steps: "Open login page => Login form is displayed | Enter valid credentials => Fields accept the input | Submit the form => User is redirected to the dashboard",
        testData: "user@example.com",
        priority: "P2",
        severity: "Medium",
        type: "Functional",
        status: "Draft",
        suite: "Authentication",
        component: "Login",
        // Same shape the field itself validates: plain minutes or an "Xh Ym" form — see
        // normalizeEstimatedDuration in legacy.service.ts.
        estimatedDuration: "10m"
      }
    ];
    const headers = Object.keys(rows[0]);
    if (format === "xlsx") {
      await this.sendWorkbook(res, "testcase-import-template.xlsx", "Test Cases", rows, headers);
      return;
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="testcase-import-template.csv"');
    res.send(this.rowsToCsv(headers, rows));
  }

  /*
   * The import itself is POST .../testcases/import, declared next to the other bulk test case routes
   * above. It reads its body: an earlier pair of stubs here ignored theirs and hard-returned
   * {imported: 0} to any caller, signed in or not, so anything trusting them imported nothing and was
   * told it worked.
   *
   * The browser still parses the workbook and maps the columns
   * (Tesbo-Frontend/components/ImportTestCasesModal.tsx) — only the commit is server-side. It used to
   * POST one createTestCase per row, which is what made a large file take minutes.
   *
   * There is still no .../import/preview: the preview is built from the parsed workbook in the
   * browser and never needed a round trip.
   */

  @Get("/api/cycles/:cycleId/export/csv")
  async exportCycle(@Req() req: AuthenticatedRequest, @Param("cycleId") cycleId: string, @Res() res: Response) {
    const rows = await this.legacy.exportCycleExecutions(req.userId, cycleId);
    const headers = ["externalId", "title", "status", "priority", "type", "actualResult", "executedAt", "defectKey", "defectUrl"];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="test-run.csv"');
    res.send(this.rowsToCsv(headers, rows));
  }

  @Get("/api/projects/:projectId/analytics")
  projectAnalytics(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.projectAnalyticsForUser(req.userId, projectId);
  }

  @Get("/api/projects/:projectId/dashboard")
  projectDashboard(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.projectDashboardSummary(req.userId, projectId);
  }

  // Still a stub returning zeros, but no longer one that answers a caller who has no business
  // knowing whether this run exists — an unauthorized caller now gets the same 404 as for a run
  // that isn't there. (That it fabricates a zeroed summary at all is a separate, open problem.)
  @Get("/api/cycles/:cycleId/report/summary")
  async cycleSummary(@Req() req: AuthenticatedRequest, @Param("cycleId") cycleId: string) {
    await this.legacy.requireCycleAccessForUser(req.userId, cycleId);
    return { total: 0, passed: 0, failed: 0, blocked: 0, skipped: 0, untested: 0 };
  }

  @Get("/api/projects/:projectId/reports/execution")
  executionReport(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Query() query: Record<string, any>
  ) {
    return this.legacy.executionReportForUser(req.userId, projectId, query);
  }

  @Get("/api/projects/:projectId/reports/requirement-matrix")
  matrix(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.requirementMatrixForUser(req.userId, projectId);
  }

  @Get("/api/projects/:projectId/reports/repository-summary")
  repositorySummary(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.repositorySummaryForUser(req.userId, projectId);
  }

  @Get("/api/projects/:projectId/reports/overview")
  reportsOverview(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.reportsOverviewForUser(req.userId, projectId);
  }

  @Get("/api/projects/:projectId/reports/insights")
  reportsInsights(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.reportsInsightsForUser(req.userId, projectId);
  }

  @Get("/api/projects/:projectId/reports/trends")
  reportsTrends(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.reportsTrendsForUser(req.userId, projectId);
  }

  @Get("/api/projects/:projectId/reports/export/:format")
  async exportReport(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("format") format: string,
    @Query() query: Record<string, any>,
    @Res() res: Response
  ) {
    if (format !== "csv" && format !== "xlsx") {
      throw new BadRequestException({ error: `Unsupported export format "${format}". Use csv or xlsx.` });
    }
    const view = String(query.view ?? "overview");
    if (!REPORT_EXPORT_VIEWS.includes(view as ReportExportView)) {
      throw new BadRequestException({
        error: `Unknown report view "${view}". Expected one of: ${REPORT_EXPORT_VIEWS.join(", ")}.`
      });
    }
    const typedView = view as ReportExportView;
    const { headers, rows } = await this.reportExportRows(req, projectId, typedView, query);
    const fileName = `report-${typedView}`;
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}.csv"`);
      res.send(this.rowsToCsv(headers, rows));
      return;
    }
    await this.sendWorkbook(res, `${fileName}.xlsx`, REPORT_VIEW_SHEET_NAMES[typedView], rows, headers);
  }

  private longRow(section: string, label: string, metric: string, value: unknown): Record<string, unknown> {
    // `?? ""` rather than String(value): a real 0 has to survive as 0, and a null pass rate (a run
    // with nothing executed yet) has to read as blank rather than the word "null".
    return { section, label, metric, value: value ?? "" };
  }

  private async reportExportRows(
    req: AuthenticatedRequest,
    projectId: string,
    view: ReportExportView,
    query: Record<string, any>
  ): Promise<{ headers: string[]; rows: Record<string, unknown>[] }> {
    if (view === "execution") {
      // The screen's filter travels with the export: exporting "the execution report" while looking
      // at one plan should not hand back every plan. filterBy/filterValue are the same query params
      // the tab itself sends, and executionReport applies them.
      const report = await this.legacy.executionReportForUser(req.userId, projectId, query);
      const rows = (report.rows ?? []).map((row: Record<string, unknown>) => ({
        groupName: row.groupName,
        Passed: row.Passed,
        Failed: row.Failed,
        Blocked: row.Blocked,
        Skipped: row.Skipped,
        Untested: row.Untested,
        Retest: row.Retest,
        total: row.total
      }));
      return { headers: REPORT_EXECUTION_HEADERS, rows };
    }

    if (view === "matrix") {
      const matrix = await this.legacy.requirementMatrixForUser(req.userId, projectId);
      const rows = (matrix.rows ?? []).map((row: Record<string, unknown>) =>
        Object.fromEntries(REPORT_MATRIX_HEADERS.map((header) => [header, row[header] ?? ""]))
      );
      return { headers: REPORT_MATRIX_HEADERS, rows };
    }

    if (view === "overview") {
      const overview = await this.legacy.reportsOverviewForUser(req.userId, projectId);
      const rows: Record<string, unknown>[] = [
        this.longRow("summary", "", "trendDelta", overview.trendDelta),
        this.longRow("summary", "", "flakyCount", overview.flakyCount),
        this.longRow("summary", "", "coverageGapCount", overview.coverageGapCount),
        this.longRow("summary", "", "untestedP1Count", overview.untestedP1Count),
        this.longRow("summary", "", "aiSummary", overview.aiSummary)
      ];
      for (const point of overview.passRateTrend ?? []) {
        rows.push(this.longRow("passRateTrend", point.name, "total", point.total));
        rows.push(this.longRow("passRateTrend", point.name, "executed", point.executed));
        rows.push(this.longRow("passRateTrend", point.name, "passRate", point.passRate));
        rows.push(this.longRow("passRateTrend", point.name, "createdAt", point.createdAt));
      }
      for (const suite of overview.suiteHealth ?? []) {
        rows.push(this.longRow("suiteHealth", suite.suiteName, "executed", suite.executed));
        rows.push(this.longRow("suiteHealth", suite.suiteName, "passedPct", suite.passedPct));
        rows.push(this.longRow("suiteHealth", suite.suiteName, "failedPct", suite.failedPct));
        rows.push(this.longRow("suiteHealth", suite.suiteName, "blockedPct", suite.blockedPct));
      }
      return { headers: REPORT_LONG_HEADERS, rows };
    }

    if (view === "repository") {
      const summary = await this.legacy.repositorySummaryForUser(req.userId, projectId);
      const rows: Record<string, unknown>[] = [
        this.longRow("summary", "", "totalTestCases", summary.totalTestCases),
        this.longRow("summary", "", "updatedToday", summary.updatedToday),
        this.longRow("summary", "", "updatedThisWeek", summary.updatedThisWeek),
        this.longRow("summary", "", "updatedThisMonth", summary.updatedThisMonth)
      ];
      for (const bucket of summary.bySuite ?? []) rows.push(this.longRow("bySuite", String(bucket.name), "count", bucket.count));
      for (const bucket of summary.byStatus ?? []) rows.push(this.longRow("byStatus", String(bucket.name), "count", bucket.count));
      for (const bucket of summary.byPriority ?? []) rows.push(this.longRow("byPriority", String(bucket.name), "count", bucket.count));
      for (const bucket of summary.addedByDate ?? []) rows.push(this.longRow("addedByDate", String(bucket.date), "count", bucket.count));
      return { headers: REPORT_LONG_HEADERS, rows };
    }

    if (view === "insights") {
      const insights = await this.legacy.reportsInsightsForUser(req.userId, projectId);
      const rows: Record<string, unknown>[] = [
        this.longRow("summary", "", "healthScore", insights.healthScore),
        this.longRow("summary", "", "healthLabel", insights.healthLabel),
        this.longRow("summary", "", "untestedP1Count", insights.untestedP1Count)
      ];
      for (const test of insights.flakyTests ?? []) {
        const label = String(test.externalId || test.title || "");
        rows.push(this.longRow("flakyTests", label, "title", test.title));
        rows.push(this.longRow("flakyTests", label, "suiteName", test.suiteName));
        rows.push(this.longRow("flakyTests", label, "flipCount", test.flipCount));
        rows.push(this.longRow("flakyTests", label, "flakinessLabel", test.flakinessLabel));
      }
      for (const gap of insights.coverageGaps ?? []) {
        rows.push(this.longRow("coverageGaps", gap.suiteName, "total", gap.total));
        rows.push(this.longRow("coverageGaps", gap.suiteName, "covered", gap.covered));
        rows.push(this.longRow("coverageGaps", gap.suiteName, "pct", gap.pct));
      }
      for (const suite of insights.coverageBySuite ?? []) {
        rows.push(this.longRow("coverageBySuite", suite.suiteName, "total", suite.total));
        rows.push(this.longRow("coverageBySuite", suite.suiteName, "covered", suite.covered));
        rows.push(this.longRow("coverageBySuite", suite.suiteName, "pct", suite.pct));
      }
      return { headers: REPORT_LONG_HEADERS, rows };
    }

    const trends = await this.legacy.reportsTrendsForUser(req.userId, projectId);
    const rows: Record<string, unknown>[] = [this.longRow("summary", "", "trendDelta", trends.trendDelta)];
    for (const point of trends.passRateTrend ?? []) {
      rows.push(this.longRow("passRateTrend", point.name, "total", point.total));
      rows.push(this.longRow("passRateTrend", point.name, "executed", point.executed));
      rows.push(this.longRow("passRateTrend", point.name, "passRate", point.passRate));
      rows.push(this.longRow("passRateTrend", point.name, "createdAt", point.createdAt));
    }
    for (const bucket of trends.executionVelocity ?? []) {
      rows.push(this.longRow("executionVelocity", String(bucket.name), "count", bucket.count));
    }
    for (const bucket of trends.bugDiscoveryRate ?? []) {
      rows.push(this.longRow("bugDiscoveryRate", String(bucket.week), "count", bucket.count));
    }
    return { headers: REPORT_LONG_HEADERS, rows };
  }

  @Post("/api/projects/:projectId/ai/generate-testcases")
  generateAi(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.aiGenerate(projectId, req.userId, body);
  }

  // REMOVED: POST /api/projects/:projectId/ai/review-script
  //
  // It was a stub that took no caller, resolved no project, called no model, and answered every
  // request — including an unauthenticated one, and one carrying a script that cannot parse — with
  // { status: "passed", categories: [], validatedSteps: [] }. An "AI review" that always reports a
  // pass is worse than none: it is a green tick with nothing behind it.
  //
  // Deleted rather than implemented, for the same reason the import stubs were (§3 bug 15): nothing
  // in Tesbo-Frontend calls it, so there is no feature to keep working — only a route that lied.
  // Reinstate it alongside a real implementation, not before.

  @Get("/api/projects/:projectId/ai/generation-history")
  aiHistory(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.aiHistory(projectId, req.userId, query);
  }

  @Post("/api/projects/:projectId/ai/generation-history/:requestId/save")
  aiSave(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("requestId") requestId: string,
    @Body() body: Record<string, any>
  ) {
    return this.legacy.aiSave(projectId, req.userId, requestId, body);
  }

  @Get("/api/projects/:projectId/agents/zyra")
  zyraAgent(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.zyraAgent(projectId, req.userId);
  }

  @Get("/api/projects/:projectId/agents/zyra/test")
  testZyraConnection(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.testZyraAiConnection(projectId, req.userId);
  }

  @Patch("/api/projects/:projectId/agents/zyra/settings")
  updateZyraSettings(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.updateZyraSettings(projectId, req.userId, body);
  }

  @Get("/api/projects/:projectId/agents/zyra/chat/sessions")
  zyraChatSessions(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.zyraChatSessions(projectId, req.userId);
  }

  @Post("/api/projects/:projectId/agents/zyra/chat/sessions")
  createZyraChatSession(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createZyraChatSession(projectId, req.userId, body);
  }

  @Get("/api/projects/:projectId/agents/zyra/chat/sessions/:sessionId")
  zyraChatSession(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("sessionId") sessionId: string) {
    return this.legacy.zyraChatSession(projectId, req.userId, sessionId);
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

  @Post("/api/projects/:projectId/agents/zyra/chat/sessions/:sessionId/messages/:messageId/continue")
  continueZyraChatMessage(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("sessionId") sessionId: string,
    @Param("messageId") messageId: string
  ) {
    return this.legacy.continueZyraChatMessage(projectId, req.userId, sessionId, messageId);
  }

  @Post("/api/projects/:projectId/agents/zyra/chat/sessions/:sessionId/stop-plan")
  stopZyraChatPlan(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("sessionId") sessionId: string
  ) {
    return this.legacy.stopZyraChatPlan(projectId, req.userId, sessionId);
  }

  @Post("/api/projects/:projectId/agents/zyra/chat/sessions/:sessionId/resume-plan")
  resumeZyraChatPlan(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("sessionId") sessionId: string
  ) {
    return this.legacy.resumeZyraChatPlan(projectId, req.userId, sessionId);
  }

  @Post("/api/projects/:projectId/agents/zyra/tasks")
  createZyraTask(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.aiGenerate(projectId, req.userId, body);
  }

  @Get("/api/projects/:projectId/agents/zyra/tasks/:taskId")
  getZyraTask(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("taskId") taskId: string) {
    return this.legacy.zyraTask(projectId, req.userId, taskId);
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
  deleteZyraDraft(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("taskId") taskId: string,
    @Param("draftIndex") draftIndex: string
  ) {
    return this.legacy.zyraDeleteDraft(projectId, req.userId, taskId, Number(draftIndex));
  }

  @Patch("/api/projects/:projectId/agents/zyra/tasks/:taskId/drafts/:draftIndex")
  editZyraDraft(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("taskId") taskId: string,
    @Param("draftIndex") draftIndex: string,
    @Body() body: Record<string, any>
  ) {
    return this.legacy.zyraEditDraft(projectId, req.userId, taskId, Number(draftIndex), body);
  }

  @Post("/api/projects/:projectId/agents/zyra/tasks/:taskId/close")
  closeZyraTask(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("taskId") taskId: string) {
    return this.legacy.zyraCloseTask(projectId, req.userId, taskId);
  }

  @Post("/api/projects/:projectId/agents/zyra/tasks/:taskId/save")
  saveZyraTask(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("taskId") taskId: string, @Body() body: Record<string, any>) {
    return this.legacy.zyraSave(projectId, req.userId, taskId, body);
  }

  // ─── Knowledge Base v2 (folders / documents / files) ────────────────────────
  // NOTE: these routes must stay ABOVE the legacy /knowledge-base/:itemId routes
  // below, since literal segments like "folders"/"search" would otherwise be
  // captured by that older single-param route.

  @Post("/api/projects/:projectId/knowledge-base/folders")
  createKnowledgeFolder(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createKnowledgeFolder(projectId, req.userId, body);
  }

  @Get("/api/projects/:projectId/knowledge-base/folders/tree")
  getKnowledgeFolderTree(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.getKnowledgeFolderTree(projectId, req.userId);
  }

  @Get("/api/projects/:projectId/knowledge-base/summary")
  getKnowledgeBaseSummary(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.knowledgeBaseSummary(projectId, req.userId);
  }

  @Get("/api/projects/:projectId/knowledge-base/folders/:folderId/export")
  async exportKnowledgeFolder(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Param("projectId") projectId: string,
    @Param("folderId") folderId: string
  ) {
    const { buffer, filename } = await this.legacy.exportKnowledgeFolder(projectId, req.userId, folderId);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
    res.send(buffer);
  }

  @Get("/api/projects/:projectId/knowledge-base/folders/:folderId")
  getKnowledgeFolder(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("folderId") folderId: string) {
    return this.legacy.getKnowledgeFolder(projectId, req.userId, folderId);
  }

  @Get("/api/projects/:projectId/knowledge-base/folders/:folderId/items")
  listKnowledgeFolderItems(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("folderId") folderId: string,
    @Query() query: Record<string, any>
  ) {
    return this.legacy.listKnowledgeFolderItems(projectId, req.userId, folderId, query);
  }

  @Patch("/api/projects/:projectId/knowledge-base/folders/:folderId/move")
  moveKnowledgeFolder(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("folderId") folderId: string,
    @Body() body: Record<string, any>
  ) {
    return this.legacy.moveKnowledgeFolder(projectId, req.userId, folderId, body);
  }

  @Patch("/api/projects/:projectId/knowledge-base/folders/:folderId/restore")
  restoreKnowledgeFolder(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("folderId") folderId: string) {
    return this.legacy.restoreKnowledgeFolder(projectId, req.userId, folderId);
  }

  @Patch("/api/projects/:projectId/knowledge-base/folders/:folderId")
  updateKnowledgeFolder(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("folderId") folderId: string,
    @Body() body: Record<string, any>
  ) {
    return this.legacy.updateKnowledgeFolder(projectId, req.userId, folderId, body);
  }

  @Delete("/api/projects/:projectId/knowledge-base/folders/:folderId")
  deleteKnowledgeFolder(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("folderId") folderId: string) {
    return this.legacy.deleteKnowledgeFolder(projectId, req.userId, folderId);
  }

  @Get("/api/projects/:projectId/knowledge-base/search")
  searchKnowledgeBase(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.searchKnowledgeBase(projectId, req.userId, query);
  }

  @Get("/api/projects/:projectId/knowledge-base/documents")
  listKnowledgeDocuments(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.listKnowledgeDocuments(projectId, req.userId, query);
  }

  @Post("/api/projects/:projectId/knowledge-base/documents")
  createKnowledgeDocument(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createKnowledgeDocument(projectId, req.userId, body);
  }

  @Get("/api/projects/:projectId/knowledge-base/documents/:documentId/versions")
  listKnowledgeDocumentVersions(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("documentId") documentId: string) {
    return this.legacy.listKnowledgeDocumentVersions(projectId, req.userId, documentId);
  }

  @Post("/api/projects/:projectId/knowledge-base/documents/:documentId/restore-version")
  restoreKnowledgeDocumentVersion(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("documentId") documentId: string,
    @Body() body: Record<string, any>
  ) {
    return this.legacy.restoreKnowledgeDocumentVersion(projectId, req.userId, documentId, body);
  }

  @Patch("/api/projects/:projectId/knowledge-base/documents/:documentId/approve-ai-memory")
  approveAiMemory(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("documentId") documentId: string) {
    return this.legacy.approveAiMemory(projectId, req.userId, documentId);
  }

  @Patch("/api/projects/:projectId/knowledge-base/documents/:documentId/reject-ai-memory")
  rejectAiMemory(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("documentId") documentId: string) {
    return this.legacy.rejectAiMemory(projectId, req.userId, documentId);
  }

  // ── Document comments ──
  // Must stay above the bare /documents/:documentId route below, same ordering constraint noted
  // at the top of this Knowledge Base block.

  @Get("/api/projects/:projectId/knowledge-base/documents/:documentId/comments")
  listKnowledgeDocumentComments(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("documentId") documentId: string) {
    return this.legacy.listKnowledgeDocumentComments(projectId, req.userId, documentId);
  }

  @Post("/api/projects/:projectId/knowledge-base/documents/:documentId/comments")
  createKnowledgeDocumentComment(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("documentId") documentId: string,
    @Body() body: Record<string, any>
  ) {
    return this.legacy.createKnowledgeDocumentComment(projectId, req.userId, documentId, body);
  }

  @Patch("/api/projects/:projectId/knowledge-base/comments/:commentId")
  updateKnowledgeDocumentComment(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("commentId") commentId: string,
    @Body() body: Record<string, any>
  ) {
    return this.legacy.updateKnowledgeDocumentComment(projectId, req.userId, commentId, body);
  }

  @Delete("/api/projects/:projectId/knowledge-base/comments/:commentId")
  deleteKnowledgeDocumentComment(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("commentId") commentId: string) {
    return this.legacy.deleteKnowledgeDocumentComment(projectId, req.userId, commentId);
  }

  @Get("/api/projects/:projectId/knowledge-base/documents/:documentId")
  getKnowledgeDocument(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("documentId") documentId: string) {
    return this.legacy.getKnowledgeDocument(projectId, req.userId, documentId);
  }

  @Get("/api/projects/:projectId/knowledge-base/documents/:documentId/sync-events")
  getKnowledgeDocumentSyncEvents(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("documentId") documentId: string,
    @Query() query: Record<string, any>
  ) {
    return this.legacy.getKnowledgeDocumentSyncEvents(projectId, req.userId, documentId, query);
  }

  @Patch("/api/projects/:projectId/knowledge-base/documents/:documentId/move")
  moveKnowledgeDocument(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("documentId") documentId: string,
    @Body() body: Record<string, any>
  ) {
    return this.legacy.moveKnowledgeDocument(projectId, req.userId, documentId, body);
  }

  @Patch("/api/projects/:projectId/knowledge-base/documents/:documentId/restore")
  restoreKnowledgeDocument(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("documentId") documentId: string) {
    return this.legacy.restoreKnowledgeDocument(projectId, req.userId, documentId);
  }

  @Post("/api/projects/:projectId/knowledge-base/documents/:documentId/duplicate")
  duplicateKnowledgeDocument(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("documentId") documentId: string) {
    return this.legacy.duplicateKnowledgeDocument(projectId, req.userId, documentId);
  }

  @Patch("/api/projects/:projectId/knowledge-base/documents/:documentId")
  updateKnowledgeDocument(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("documentId") documentId: string,
    @Body() body: Record<string, any>
  ) {
    return this.legacy.updateKnowledgeDocument(projectId, req.userId, documentId, body);
  }

  @Delete("/api/projects/:projectId/knowledge-base/documents/:documentId")
  deleteKnowledgeDocument(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("documentId") documentId: string) {
    return this.legacy.deleteKnowledgeDocument(projectId, req.userId, documentId);
  }

  @Post("/api/projects/:projectId/knowledge-base/files/upload")
  @UseInterceptors(FilesInterceptor("files", 10, { limits: { fileSize: LegacyService.KB_MAX_UPLOAD_SIZE } }))
  uploadKnowledgeFiles(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Body() body: Record<string, any>,
    @UploadedFiles() files: Array<{ buffer: Buffer; originalname: string; mimetype: string; size: number }>
  ) {
    return this.legacy.uploadKnowledgeFiles(projectId, req.userId, body.folderId, files);
  }

  @Get("/api/projects/:projectId/knowledge-base/files/:fileId/download")
  async downloadKnowledgeFile(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Param("projectId") projectId: string,
    @Param("fileId") fileId: string
  ) {
    const access = await this.legacy.getKnowledgeFileAccess(projectId, req.userId, fileId, false);
    if ("redirectUrl" in access) return res.redirect(302, access.redirectUrl);
    res.setHeader("Content-Type", access.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(access.originalFileName)}"`);
    if ("buffer" in access && access.buffer) return res.send(access.buffer);
    if ("localPath" in access && access.localPath) return res.sendFile(access.localPath);
    throw new Error("Knowledge file content unavailable");
  }

  @Get("/api/projects/:projectId/knowledge-base/files/:fileId/preview")
  async previewKnowledgeFile(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Param("projectId") projectId: string,
    @Param("fileId") fileId: string
  ) {
    const access = await this.legacy.getKnowledgeFileAccess(projectId, req.userId, fileId, true);
    if ("redirectUrl" in access) return res.redirect(302, access.redirectUrl);
    res.setHeader("Content-Type", access.mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(access.originalFileName)}"`);
    if ("buffer" in access) return res.send(access.buffer);
    res.sendFile(access.localPath);
  }

  @Get("/api/projects/:projectId/knowledge-base/files/:fileId")
  getKnowledgeFile(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("fileId") fileId: string) {
    return this.legacy.getKnowledgeFile(projectId, req.userId, fileId);
  }

  @Patch("/api/projects/:projectId/knowledge-base/files/:fileId/move")
  moveKnowledgeFile(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("fileId") fileId: string,
    @Body() body: Record<string, any>
  ) {
    return this.legacy.moveKnowledgeFile(projectId, req.userId, fileId, body);
  }

  @Patch("/api/projects/:projectId/knowledge-base/files/:fileId/restore")
  restoreKnowledgeFile(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("fileId") fileId: string) {
    return this.legacy.restoreKnowledgeFile(projectId, req.userId, fileId);
  }

  @Patch("/api/projects/:projectId/knowledge-base/files/:fileId")
  updateKnowledgeFile(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("fileId") fileId: string,
    @Body() body: Record<string, any>
  ) {
    return this.legacy.updateKnowledgeFile(projectId, req.userId, fileId, body);
  }

  @Delete("/api/projects/:projectId/knowledge-base/files/:fileId")
  deleteKnowledgeFile(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("fileId") fileId: string) {
    return this.legacy.deleteKnowledgeFile(projectId, req.userId, fileId);
  }

  // ─── Knowledge Base v1 (legacy flat notes/files — superseded by v2 above) ────

  @Get("/api/projects/:projectId/knowledge-base")
  knowledge(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.listKnowledge(projectId, req.userId, query);
  }

  @Post("/api/projects/:projectId/knowledge-base")
  createKnowledge(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.createKnowledge(projectId, req.userId, body);
  }

  @Post("/api/projects/:projectId/knowledge-base/upload")
  async uploadKnowledge(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    await this.legacy.requireProjectAccess(req.userId, projectId);
    return { error: "File uploads are not enabled in this endpoint yet" };
  }

  @Get("/api/projects/:projectId/knowledge-base/:itemId")
  getKnowledge(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("itemId") itemId: string) {
    return this.legacy.getKnowledge(projectId, req.userId, itemId);
  }

  @Patch("/api/projects/:projectId/knowledge-base/:itemId")
  updateKnowledge(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("itemId") itemId: string,
    @Body() body: Record<string, any>
  ) {
    return this.legacy.updateKnowledge(projectId, req.userId, itemId, body);
  }

  @Delete("/api/projects/:projectId/knowledge-base/:itemId")
  deleteKnowledge(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("itemId") itemId: string) {
    return this.legacy.deleteKnowledge(projectId, req.userId, itemId);
  }

  @Get("/api/projects/:projectId/knowledge-base/:itemId/file")
  knowledgeFile(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("itemId") itemId: string) {
    return this.legacy.knowledgeItemFile(projectId, req.userId, itemId);
  }

  // ── Workspace-scoped app integrations (Jira, Linear) ──
  // Connecting/configuring an app is workspace-wide; see the project-scoped mapping/sync/ticket
  // routes further below for picking which remote project/team feeds a given Tesbo project.

  @Get("/api/workspace/integrations/:provider/auth-url")
  integrationAuthUrl(@Req() req: AuthenticatedRequest, @Param("provider") provider: string) {
    return this.legacy.integrationAuthUrl(req.userId, provider);
  }

  @Get("/api/workspace/integrations/:provider/config")
  integrationConfig(@Req() req: AuthenticatedRequest, @Param("provider") provider: string) {
    return this.legacy.integrationConfigStatus(req.userId, provider);
  }

  @Post("/api/workspace/integrations/:provider/callback")
  integrationCallback(@Req() req: AuthenticatedRequest, @Param("provider") provider: string, @Body() body: Record<string, any>) {
    return this.legacy.integrationCallback(req.userId, provider, body);
  }

  @Delete("/api/workspace/integrations/:provider/disconnect")
  integrationDisconnect(@Req() req: AuthenticatedRequest, @Param("provider") provider: string) {
    return this.legacy.integrationDisconnect(req.userId, provider);
  }

  @Get("/api/workspace/integrations/:provider/status")
  integrationStatus(@Req() req: AuthenticatedRequest, @Param("provider") provider: string) {
    return this.legacy.integrationStatus(req.userId, provider);
  }

  // ── Project-scoped Jira mapping/sync/tickets ──

  @Get("/api/projects/:projectId/jira/status")
  jiraStatus(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.jiraStatus(projectId, req.userId);
  }

  @Get("/api/projects/:projectId/jira/projects")
  jiraProjects(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.jiraProjects(projectId, req.userId);
  }

  @Post("/api/projects/:projectId/jira/projects")
  connectJiraProjects(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.connectJiraProjects(projectId, req.userId, body);
  }

  @Post("/api/projects/:projectId/jira/sync")
  syncJira(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.syncJira(req.userId, projectId);
  }

  @Get("/api/projects/:projectId/jira/tickets")
  jiraTickets(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.jiraTickets(projectId, req.userId, query);
  }

  @Post("/api/projects/:projectId/jira/comment")
  jiraComment(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.jiraComment(projectId, req.userId, body);
  }

  @Get("/api/projects/:projectId/jira/search-issues")
  jiraSearchIssues(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.jiraSearchIssues(projectId, req.userId, query);
  }

  // ── Project-scoped Linear mapping/sync/tickets ──

  @Get("/api/projects/:projectId/linear/status")
  linearStatus(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.linearStatus(projectId, req.userId);
  }

  @Get("/api/projects/:projectId/linear/teams")
  linearTeams(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.linearTeams(projectId, req.userId);
  }

  @Post("/api/projects/:projectId/linear/teams")
  connectLinearTeams(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.connectLinearTeams(projectId, req.userId, body);
  }

  @Post("/api/projects/:projectId/linear/sync")
  syncLinear(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.syncLinear(req.userId, projectId);
  }

  // ── Sync run status (polled by the Requirements page while a sync is in flight) ──

  @Get("/api/projects/:projectId/integrations/:provider/sync-status")
  integrationSyncStatus(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("provider") provider: string) {
    return this.legacy.integrationSyncStatus(req.userId, projectId, provider);
  }

  @Get("/api/projects/:projectId/integrations/sync-history")
  integrationSyncHistory(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.integrationSyncHistory(req.userId, projectId);
  }

  @Get("/api/projects/:projectId/linear/tickets")
  linearTickets(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.linearTickets(projectId, req.userId, query);
  }

  @Post("/api/projects/:projectId/linear/comment")
  linearComment(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.legacy.linearComment(projectId, req.userId, body);
  }

  @Get("/api/projects/:projectId/linear/search-issues")
  linearSearchIssues(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.linearSearchIssues(projectId, req.userId, query);
  }

  // ── Requirements page: cross-source (Jira + Linear) aggregates ──

  @Get("/api/projects/:projectId/tickets/summary")
  requirementsSummary(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.requirementsSummary(projectId, req.userId);
  }

  @Get("/api/projects/:projectId/tickets")
  allTickets(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.allTickets(projectId, req.userId, query);
  }

  @Get("/api/projects/:projectId/activity")
  activity(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Query() query: Record<string, any>) {
    return this.legacy.listActivityForUser(req.userId, projectId, query);
  }

  @Get("/api/projects/:projectId/activity/summary")
  activitySummary(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.legacy.activitySummaryForUser(req.userId, projectId);
  }

  @Get("/api/workspace/activity")
  workspaceActivity(@Req() req: AuthenticatedRequest, @Query() query: Record<string, any>) {
    return this.legacy.workspaceActivity(req.userId, query);
  }

  @Get("/api/workspace/activity/summary")
  workspaceActivitySummary(@Req() req: AuthenticatedRequest) {
    return this.legacy.workspaceActivitySummaryForUser(req.userId);
  }

  /*
   * Notifications are not implemented yet — there is no table behind them, so the list is empty and
   * there is nothing to mark read. Both routes still take the caller: they previously took none at
   * all, which meant "your notifications" was answerable without knowing who was asking, and
   * mark-as-read reported success for any id to anybody.
   *
   * The empty list is a missing feature, recorded in docs/e2e-coverage-waves.md. The 404 below is the
   * honest answer while it stays missing: no such notification exists.
   */
  @Get("/api/notifications")
  async notifications(@Req() req: AuthenticatedRequest) {
    await this.legacy.requireSession(req.userId);
    return [];
  }

  @Post("/api/notifications/:id/read")
  async readNotification(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    await this.legacy.requireSession(req.userId);
    throw new NotFoundException({ error: "Notification not found" });
  }

  @Get("/api/admin/customers")
  customers(@Req() req: AuthenticatedRequest) {
    return this.legacy.adminCustomers(req.userId);
  }

  @Get("/api/admin/admins")
  admins(@Req() req: AuthenticatedRequest) {
    return this.legacy.adminList(req.userId);
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
    return this.legacy.addAdmin(req.userId, body);
  }

  @Delete("/api/admin/admins/:adminId")
  removeAdmin(@Req() req: AuthenticatedRequest, @Param("adminId") adminId: string) {
    return this.legacy.deleteAdmin(req.userId, adminId);
  }

  /*
   * The external Tesbo Reports ingest is not implemented — these six routes return empty lists and
   * zeroed analytics. What they no longer do is answer without a caller: they took no @Req() and
   * ignored the project in their own URL, so any request at all was served, and `settings` is shaped
   * to carry an ingestion credential. The placeholder payloads are a missing feature, recorded in
   * docs/e2e-coverage-waves.md; being readable by anyone was a defect regardless of what fills them.
   *
   * SUPERSEDED, and will not be filled in as designed. Basecamp 10189985971 chose the opposite
   * linking mechanism: automation reports results against a test case's `external_id`, onto
   * ordinary `cycles`/`executions` rows, via /api/projects/:projectId/automation/* (src/automation).
   * These six were shaped around spec-name/test-name matching in a store of their own, and the
   * frontend client that called them (`listTesboRuns`, `ingestTesboPlaywright`,
   * `getTesboTestHistory(projectId, specName, testName)`, ...) has been deleted for that reason.
   * They are left standing only because removing a route is a separate, riskier change than
   * deleting an uncalled client. Nothing should be built on them --
   * see docs/automation-integration-plan.md §2, trap 2.
   */
  @Get("/api/projects/:projectId/tesbo-reports/runs")
  async tesboRuns(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    await this.legacy.requireProjectAccess(req.userId, projectId);
    return [];
  }

  @Get("/api/projects/:projectId/tesbo-reports/specs")
  async tesboSpecs(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    await this.legacy.requireProjectAccess(req.userId, projectId);
    return [];
  }

  @Get("/api/projects/:projectId/tesbo-reports/tests")
  async tesboTests(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    await this.legacy.requireProjectAccess(req.userId, projectId);
    return [];
  }

  @Get("/api/projects/:projectId/tesbo-reports/analytics")
  async tesboAnalytics(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    await this.legacy.requireProjectAccess(req.userId, projectId);
    return { totalRuns: 0, totalTests: 0, passRate: 0, byStatus: {}, runsByDay: [] };
  }

  @Get("/api/projects/:projectId/tesbo-reports/alerts")
  async tesboAlerts(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    await this.legacy.requireProjectAccess(req.userId, projectId);
    return [];
  }

  @Get("/api/projects/:projectId/tesbo-reports/settings")
  async tesboSettings(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    await this.legacy.requireProjectAccess(req.userId, projectId);
    return { keepTrace: true, traceRetentionDays: 14, ingestionApiKey: "", alertsEnabled: false, shareByDefault: false };
  }
}
