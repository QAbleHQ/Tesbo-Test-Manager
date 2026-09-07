import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";
import { AuthenticatedRequest } from "../common/request.types";
import { CustomFieldsService } from "./custom-fields.service";
import { FieldStatus } from "./custom-fields.types";

@Controller()
export class CustomFieldsController {
  constructor(private readonly customFields: CustomFieldsService) {}

  @Get("/api/projects/:projectId/custom-fields/definitions")
  listDefinitions(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Query("status") status?: string) {
    const statuses = status ? (status.split(",").filter(Boolean) as FieldStatus[]) : undefined;
    return this.customFields.listDefinitions(req.userId, projectId, statuses);
  }

  @Get("/api/projects/:projectId/custom-fields/definitions/:definitionId")
  getDefinition(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("definitionId") definitionId: string) {
    return this.customFields.getDefinition(req.userId, projectId, definitionId);
  }

  @Post("/api/projects/:projectId/custom-fields/definitions")
  createDefinition(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: Record<string, any>) {
    return this.customFields.createDefinition(req.userId, projectId, body);
  }

  @Patch("/api/projects/:projectId/custom-fields/definitions/:definitionId")
  updateDefinition(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("definitionId") definitionId: string,
    @Body() body: Record<string, any>
  ) {
    return this.customFields.updateDefinition(req.userId, projectId, definitionId, body);
  }

  @Post("/api/projects/:projectId/custom-fields/definitions/reorder")
  reorderDefinitions(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Body() body: { orderedIds: string[] }) {
    return this.customFields.reorderDefinitions(req.userId, projectId, body?.orderedIds || []);
  }

  @Patch("/api/projects/:projectId/custom-fields/definitions/:definitionId/status")
  setStatus(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("definitionId") definitionId: string,
    @Body() body: { status: FieldStatus }
  ) {
    return this.customFields.setStatus(req.userId, projectId, definitionId, body?.status);
  }

  @Post("/api/projects/:projectId/custom-fields/definitions/:definitionId/options")
  addOption(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("definitionId") definitionId: string,
    @Body() body: { label: string }
  ) {
    return this.customFields.addOption(req.userId, projectId, definitionId, body?.label);
  }

  @Patch("/api/projects/:projectId/custom-fields/definitions/:definitionId/options/:optionId")
  setOptionActive(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("definitionId") definitionId: string,
    @Param("optionId") optionId: string,
    @Body() body: { active: boolean }
  ) {
    return this.customFields.setOptionActive(req.userId, projectId, definitionId, optionId, Boolean(body?.active));
  }

  @Delete("/api/projects/:projectId/custom-fields/definitions/:definitionId")
  deleteDefinition(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("definitionId") definitionId: string) {
    return this.customFields.deleteDefinition(req.userId, projectId, definitionId);
  }

  @Post("/api/projects/:projectId/custom-fields/definitions/:definitionId/restore")
  restoreDefinition(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("definitionId") definitionId: string) {
    return this.customFields.restoreDefinition(req.userId, projectId, definitionId);
  }

  @Get("/api/projects/:projectId/testcases/:testcaseId/custom-field-values")
  getValues(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string, @Param("testcaseId") testcaseId: string) {
    return this.customFields.getValuesForTestCase(req.userId, projectId, testcaseId);
  }

  @Put("/api/projects/:projectId/testcases/:testcaseId/custom-field-values")
  async setValues(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("testcaseId") testcaseId: string,
    @Body() body: { values: Record<string, unknown> }
  ) {
    await this.customFields.setValuesForTestCase(req.userId, projectId, testcaseId, body?.values || {}, undefined, "enforce");
    return { success: true };
  }
}
