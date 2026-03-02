package com.bettercases.cycle;

import com.bettercases.audit.AuditService;
import com.bettercases.auth.SessionFilter;
import com.bettercases.automation.AutomationAgentClient;
import com.bettercases.tesbo.TesboArtifactStorageService;
import io.javalin.http.Context;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

public final class CycleHandler {

    /* ───── LIST ───── */
    public static void list(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        ctx.json(CycleService.list(projectId, userId));
    }

    /* ───── GET ───── */
    public static void get(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID cycleId = UUID.fromString(ctx.pathParam("cycleId"));
        ctx.json(CycleService.get(cycleId, userId).orElseThrow(() -> new io.javalin.http.NotFoundResponse()));
    }

    /* ───── CREATE (simple – Planning status, no test cases) ───── */
    public static void create(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        CreateBody body = ctx.bodyAsClass(CreateBody.class);
        if (body == null || body.name == null || body.name.isBlank()) {
            ctx.status(400).json(Map.of("error", "name is required"));
            return;
        }
        if (body.environment == null || body.environment.isBlank()) {
            ctx.status(400).json(Map.of("error", "environment is required"));
            return;
        }
        Map<String, Object> result = CycleService.create(projectId, userId, body.name, body.description, body.environment, body.buildVersion);
        try {
            AuditService.logActivity(userId, projectId, "created", "cycle",
                    String.valueOf(result.get("id")), body.name);
        } catch (Exception ignored) {}
        ctx.status(201).json(result);
    }

    /* ───── UPDATE ───── */
    public static void update(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID cycleId = UUID.fromString(ctx.pathParam("cycleId"));
        UpdateBody body = ctx.bodyAsClass(UpdateBody.class);
        if (body == null) body = new UpdateBody();
        UUID planId = body.planId != null ? UUID.fromString(body.planId) : null;
        boolean clearPlan = body.clearPlan != null && body.clearPlan;
        CycleService.update(cycleId, userId, body.name, body.description, body.environment, body.buildVersion, body.status, planId, clearPlan);
        try {
            UUID projectId = CycleService.getProjectIdForCycle(cycleId);
            if (projectId != null) {
                AuditService.logActivity(userId, projectId, "updated", "cycle",
                        cycleId.toString(), body.name);
            }
        } catch (Exception ignored) {}
        ctx.status(204);
    }

    /* ───── DELETE ───── */
    public static void delete(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID cycleId = UUID.fromString(ctx.pathParam("cycleId"));
        UUID projectId = null;
        try {
            projectId = CycleService.getProjectIdForCycle(cycleId);
        } catch (Exception ignored) {}
        CycleService.delete(cycleId, userId);
        try {
            if (projectId != null) {
                AuditService.logActivity(userId, projectId, "deleted", "cycle",
                        cycleId.toString(), null);
            }
        } catch (Exception ignored) {}
        ctx.status(204);
    }

    /* ───── ADD test cases to run ───── */
    public static void addTestCases(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID cycleId = UUID.fromString(ctx.pathParam("cycleId"));
        AddTestCasesBody body = ctx.bodyAsClass(AddTestCasesBody.class);
        if (body == null || body.testcaseIds == null || body.testcaseIds.isEmpty()) {
            ctx.status(400).json(Map.of("error", "testcaseIds required"));
            return;
        }
        List<UUID> ids = body.testcaseIds.stream().map(UUID::fromString).collect(Collectors.toList());
        CycleService.addTestCases(cycleId, userId, ids);
        ctx.status(204);
    }

    /* ───── REMOVE a test case from run ───── */
    public static void removeTestCase(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID cycleId = UUID.fromString(ctx.pathParam("cycleId"));
        UUID testcaseId = UUID.fromString(ctx.pathParam("testcaseId"));
        CycleService.removeTestCase(cycleId, userId, testcaseId);
        ctx.status(204);
    }

    /* ───── CREATE from plan (existing) ───── */
    public static void createFromPlan(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        CreateFromPlanBody body = ctx.bodyAsClass(CreateFromPlanBody.class);
        if (body == null || body.planId == null) {
            ctx.status(400).json(Map.of("error", "planId required"));
            return;
        }
        if (body.environment == null || body.environment.isBlank()) {
            ctx.status(400).json(Map.of("error", "environment is required"));
            return;
        }
        String name = body.name != null ? body.name : "Test Run";
        Map<String, Object> result = CycleService.createFromPlan(projectId, userId, UUID.fromString(body.planId), name, body.environment, body.buildVersion);
        try {
            AuditService.logActivity(userId, projectId, "created", "cycle",
                    String.valueOf(result.get("id")), name);
        } catch (Exception ignored) {}
        ctx.status(201).json(result);
    }

    /* ───── CREATE from cases (existing) ───── */
    public static void createFromCases(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        CreateFromCasesBody body = ctx.bodyAsClass(CreateFromCasesBody.class);
        if (body == null || body.testcaseIds == null || body.testcaseIds.isEmpty()) {
            ctx.status(400).json(Map.of("error", "testcaseIds required"));
            return;
        }
        if (body.environment == null || body.environment.isBlank()) {
            ctx.status(400).json(Map.of("error", "environment is required"));
            return;
        }
        List<UUID> ids = body.testcaseIds.stream().map(UUID::fromString).collect(Collectors.toList());
        String name = body.name != null ? body.name : "Test Run";
        Map<String, Object> result = CycleService.createFromCases(projectId, userId, name, body.environment, body.buildVersion, ids);
        try {
            AuditService.logActivity(userId, projectId, "created", "cycle",
                    String.valueOf(result.get("id")), name);
        } catch (Exception ignored) {}
        ctx.status(201).json(result);
    }

    /* ───── LIST executions ───── */
    public static void listExecutions(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID cycleId = UUID.fromString(ctx.pathParam("cycleId"));
        ctx.json(CycleService.listExecutions(cycleId, userId));
    }

    /* ───── UPDATE execution ───── */
    public static void updateExecution(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID executionId = UUID.fromString(ctx.pathParam("executionId"));
        UpdateExecutionBody body = ctx.bodyAsClass(UpdateExecutionBody.class);
        if (body == null) body = new UpdateExecutionBody();
        UUID assigneeId = body.assigneeId != null ? UUID.fromString(body.assigneeId) : null;
        CycleService.updateExecution(executionId, userId, body.status, assigneeId, body.actualResult, body.defectKey, body.defectUrl);
        ctx.status(204);
    }

    /* ───── GET automation report for execution ───── */
    public static void getExecutionAutomationReport(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID cycleId = UUID.fromString(ctx.pathParam("cycleId"));
        UUID executionId = UUID.fromString(ctx.pathParam("executionId"));
        ctx.json(ExecutionAutomationReportService.get(cycleId, executionId, userId));
    }

    /* ───── STREAM automation video for execution ───── */
    public static void streamExecutionAutomationVideo(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID cycleId = UUID.fromString(ctx.pathParam("cycleId"));
        UUID executionId = UUID.fromString(ctx.pathParam("executionId"));
        try {
            TesboArtifactStorageService.ArtifactReadResult result =
                    ExecutionAutomationReportService.getVideoArtifact(cycleId, executionId, userId);
            if (result.redirect()) {
                ctx.redirect(result.redirectUrl());
                return;
            }
            if (result.contentType() != null) ctx.contentType(result.contentType());
            ctx.result(result.stream());
        } catch (io.javalin.http.HttpResponseException e) {
            throw e;
        } catch (Exception e) {
            throw new io.javalin.http.NotFoundResponse("Automation video not found");
        }
    }

    public static void streamExecutionAutomationTrace(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID cycleId = UUID.fromString(ctx.pathParam("cycleId"));
        UUID executionId = UUID.fromString(ctx.pathParam("executionId"));
        try {
            TesboArtifactStorageService.ArtifactReadResult result =
                    ExecutionAutomationReportService.getTraceArtifact(cycleId, executionId, userId);
            if (result.redirect()) {
                ctx.redirect(result.redirectUrl());
                return;
            }
            if (result.contentType() != null) ctx.contentType(result.contentType());
            ctx.result(result.stream());
        } catch (io.javalin.http.HttpResponseException e) {
            throw e;
        } catch (Exception e) {
            throw new io.javalin.http.NotFoundResponse("Automation trace not found");
        }
    }

    /* ───── RUN automated test cases (manual trigger) ───── */
    public static void executeAutomated(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID cycleId = UUID.fromString(ctx.pathParam("cycleId"));
        ctx.status(202).json(CycleAutomationRunService.executeAutomatedAsync(cycleId, userId, false));
    }

    /* ───── CANCEL automated run ───── */
    public static void cancelAutomatedRun(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID cycleId = UUID.fromString(ctx.pathParam("cycleId"));
        UUID runId = UUID.fromString(ctx.pathParam("runId"));
        CycleAutomationRunService.cancelRun(cycleId, runId, userId);
        ctx.status(204);
    }

    /* ───── GET automated run live status ───── */
    public static void getAutomatedRunStatus(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID cycleId = UUID.fromString(ctx.pathParam("cycleId"));
        UUID runId = UUID.fromString(ctx.pathParam("runId"));
        ctx.json(CycleAutomationRunService.getRunStatus(cycleId, runId, userId));
    }

    public static void getLatestAutomatedRunStatus(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID cycleId = UUID.fromString(ctx.pathParam("cycleId"));
        ctx.json(CycleAutomationRunService.getLatestRunStatus(cycleId, userId));
    }

    public static void queueMetrics(Context ctx) {
        SessionFilter.requireUserId(ctx);
        ctx.json(Map.of(
                "queue", safeQueueStats(),
                "runs", AutomationQueueMetricsService.currentRunMetrics()
        ));
    }

    private static Map<String, Object> safeQueueStats() {
        try {
            return AutomationAgentClient.queueStats();
        } catch (Exception e) {
            return Map.of("status", "unavailable", "error", e.getMessage());
        }
    }

    /* ───── LIST schedules ───── */
    public static void listSchedules(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        ctx.json(CycleRunScheduleService.list(projectId, userId));
    }

    /* ───── CREATE schedule ───── */
    public static void createSchedule(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        CreateScheduleBody body = ctx.bodyAsClass(CreateScheduleBody.class);
        if (body == null || body.cycleId == null || body.name == null || body.scheduleType == null) {
            ctx.status(400).json(Map.of("error", "cycleId, name, and scheduleType are required"));
            return;
        }
        UUID cycleId = UUID.fromString(body.cycleId);
        Map<String, Object> created = CycleRunScheduleService.create(
                projectId, userId, cycleId, body.name, body.scheduleType, body.runAt,
                body.intervalMinutes, body.timezone, body.enabled
        );
        ctx.status(201).json(created);
    }

    /* ───── UPDATE schedule ───── */
    public static void updateSchedule(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID scheduleId = UUID.fromString(ctx.pathParam("scheduleId"));
        UpdateScheduleBody body = ctx.bodyAsClass(UpdateScheduleBody.class);
        if (body == null) body = new UpdateScheduleBody();
        CycleRunScheduleService.update(
                scheduleId, userId, body.name, body.enabled, body.scheduleType, body.runAt,
                body.intervalMinutes, body.timezone, body.cycleId
        );
        ctx.status(204);
    }

    /* ───── DELETE schedule ───── */
    public static void deleteSchedule(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID scheduleId = UUID.fromString(ctx.pathParam("scheduleId"));
        CycleRunScheduleService.delete(scheduleId, userId);
        ctx.status(204);
    }

    /* ───── BULK assign ───── */
    public static void bulkAssign(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID cycleId = UUID.fromString(ctx.pathParam("cycleId"));
        BulkAssignBody body = ctx.bodyAsClass(BulkAssignBody.class);
        if (body == null || body.executionIds == null || body.executionIds.isEmpty() || body.assigneeId == null) {
            ctx.status(400).json(Map.of("error", "executionIds and assigneeId required"));
            return;
        }
        List<UUID> execIds = body.executionIds.stream().map(UUID::fromString).collect(Collectors.toList());
        CycleService.bulkAssign(cycleId, userId, execIds, UUID.fromString(body.assigneeId));
        ctx.status(204);
    }

    /* ───── BULK update status ───── */
    public static void bulkUpdateStatus(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID cycleId = UUID.fromString(ctx.pathParam("cycleId"));
        BulkStatusBody body = ctx.bodyAsClass(BulkStatusBody.class);
        if (body == null || body.executionIds == null || body.executionIds.isEmpty() || body.status == null) {
            ctx.status(400).json(Map.of("error", "executionIds and status required"));
            return;
        }
        List<UUID> execIds = body.executionIds.stream().map(UUID::fromString).collect(Collectors.toList());
        CycleService.bulkUpdateStatus(cycleId, userId, execIds, body.status);
        ctx.status(204);
    }

    /* ═══════════════════ PUBLIC SHARING ═══════════════════ */

    /* ───── TOGGLE share (enable/disable) ───── */
    public static void toggleShare(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID cycleId = UUID.fromString(ctx.pathParam("cycleId"));
        ToggleShareBody body = ctx.bodyAsClass(ToggleShareBody.class);
        if (body == null) {
            ctx.status(400).json(Map.of("error", "enabled field required"));
            return;
        }
        ctx.json(CycleService.toggleShare(cycleId, userId, body.enabled));
    }

    /* ───── PUBLIC: get shared test run (no auth) ───── */
    public static void getPublicRun(Context ctx) {
        String token = ctx.pathParam("token");
        var run = CycleService.getByShareToken(token);
        if (run.isEmpty()) {
            ctx.status(404).json(Map.of("error", "Shared test run not found or sharing is disabled"));
            return;
        }
        ctx.json(run.get());
    }

    /* ───── PUBLIC: get shared test run executions (no auth) ───── */
    public static void getPublicExecutions(Context ctx) {
        String token = ctx.pathParam("token");
        var execs = CycleService.listExecutionsByShareToken(token);
        ctx.json(execs);
    }

    /* ───── Request body DTOs ───── */
    public static class CreateBody {
        public String name;
        public String description;
        public String environment;
        public String buildVersion;
    }

    public static class UpdateBody {
        public String name;
        public String description;
        public String environment;
        public String buildVersion;
        public String status;
        public String planId;
        public Boolean clearPlan;
    }

    public static class AddTestCasesBody {
        public List<String> testcaseIds;
    }

    public static class CreateFromPlanBody {
        public String planId;
        public String name;
        public String environment;
        public String buildVersion;
    }

    public static class CreateFromCasesBody {
        public List<String> testcaseIds;
        public String name;
        public String environment;
        public String buildVersion;
    }

    public static class UpdateExecutionBody {
        public String status;
        public String assigneeId;
        public String actualResult;
        public String defectKey;
        public String defectUrl;
    }

    public static class BulkAssignBody {
        public List<String> executionIds;
        public String assigneeId;
    }

    public static class BulkStatusBody {
        public List<String> executionIds;
        public String status;
    }

    public static class ToggleShareBody {
        public boolean enabled;
    }

    public static class CreateScheduleBody {
        public String cycleId;
        public String name;
        public String scheduleType;
        public String runAt;
        public Integer intervalMinutes;
        public String timezone;
        public Boolean enabled;
    }

    public static class UpdateScheduleBody {
        public String cycleId;
        public String name;
        public String scheduleType;
        public String runAt;
        public Integer intervalMinutes;
        public String timezone;
        public Boolean enabled;
    }
}
