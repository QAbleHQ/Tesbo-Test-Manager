package com.bettercases.automation;

import com.bettercases.audit.AuditService;
import com.bettercases.auth.SessionFilter;
import io.javalin.http.Context;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class AutomationSessionHandler {
    public static void start(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID testcaseId = UUID.fromString(ctx.pathParam("testcaseId"));
        AutomationContracts.StartSessionBody body = ctx.bodyAsClass(AutomationContracts.StartSessionBody.class);
        String startUrl = body != null ? body.startUrl : null;

        AutomationIntentParserService.ensureAiConfigured(projectId);
        Map<String, Object> session = AutomationSessionService.startSession(projectId, testcaseId, userId, startUrl);
        UUID sessionId = UUID.fromString(String.valueOf(session.get("id")));
        AutomationAgentClient.createSession(sessionId, startUrl);
        try {
            AuditService.logActivity(userId, projectId, "automation_session_started", "testcase", testcaseId.toString(), null);
        } catch (Exception ignored) {}
        ctx.status(201).json(session);
    }

    public static void runCommand(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID sessionId = UUID.fromString(ctx.pathParam("sessionId"));
        Map<String, Object> session = AutomationSessionService.getSession(sessionId, projectId, userId)
                .orElseThrow(io.javalin.http.NotFoundResponse::new);
        UUID testcaseId = UUID.fromString(String.valueOf(session.get("testcaseId")));
        String currentUrl = (String) session.get("currentUrl");

        AutomationContracts.CommandBody body = ctx.bodyAsClass(AutomationContracts.CommandBody.class);
        String command = body == null ? null : body.command;
        AutomationContracts.ActionPlan plan = AutomationIntentParserService.plan(projectId, command, currentUrl);

        UUID commandId = UUID.fromString(plan.commandId);
        AutomationSessionService.addEvent(
                sessionId, projectId, testcaseId, userId, commandId,
                plan.requiresClarification ? "clarification_required" : "command_received",
                command,
                Map.of(
                        "requiresClarification", plan.requiresClarification,
                        "clarificationQuestion", plan.clarificationQuestion == null ? "" : plan.clarificationQuestion,
                        "steps", plan.steps == null ? List.of() : plan.steps
                ),
                null,
                null
        );

        if (plan.requiresClarification) {
            ctx.status(202).json(Map.of(
                    "commandId", plan.commandId,
                    "requiresClarification", true,
                    "clarificationQuestion", plan.clarificationQuestion
            ));
            return;
        }

        AutomationContracts.AgentExecuteResponse executeResponse = AutomationAgentClient.executeSteps(sessionId, plan.commandId, plan.steps);
        String screenshotPath = null;
        if (executeResponse.results != null && !executeResponse.results.isEmpty()) {
            screenshotPath = executeResponse.results.get(executeResponse.results.size() - 1).screenshotPath;
        }
        AutomationSessionService.touchState(
                sessionId,
                executeResponse.currentUrl,
                screenshotPath,
                Map.of("stepCount", executeResponse.results == null ? 0 : executeResponse.results.size())
        );
        Map<String, Object> executionPayload = new HashMap<>();
        executionPayload.put("currentUrl", executeResponse.currentUrl);
        executionPayload.put("results", executeResponse.results);
        AutomationSessionService.addEvent(
                sessionId, projectId, testcaseId, userId, commandId, "command_executed",
                command,
                Map.of("steps", plan.steps),
                executionPayload,
                screenshotPath
        );
        ctx.json(Map.of(
                "commandId", plan.commandId,
                "requiresClarification", false,
                "result", executionPayload
        ));
    }

    public static void getSession(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID sessionId = UUID.fromString(ctx.pathParam("sessionId"));
        Map<String, Object> session = AutomationSessionService.getSession(sessionId, projectId, userId)
                .orElseThrow(io.javalin.http.NotFoundResponse::new);
        ctx.json(session);
    }

    public static void stream(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID sessionId = UUID.fromString(ctx.pathParam("sessionId"));
        AutomationSessionService.getSession(sessionId, projectId, userId)
                .orElseThrow(io.javalin.http.NotFoundResponse::new);
        Map<String, Object> state = AutomationAgentClient.getSessionState(sessionId);
        Object screenshotPath = state.get("lastScreenshotPath");
        if (screenshotPath instanceof String path && !path.isBlank()) {
            try {
                byte[] bytes = Files.readAllBytes(Path.of(path));
                String dataUrl = "data:image/png;base64," + Base64.getEncoder().encodeToString(bytes);
                state.put("screenshotDataUrl", dataUrl);
            } catch (Exception ignored) {}
        }
        ctx.json(state);
    }

    public static void finalizeSession(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID sessionId = UUID.fromString(ctx.pathParam("sessionId"));
        Map<String, Object> session = AutomationSessionService.getSession(sessionId, projectId, userId)
                .orElseThrow(io.javalin.http.NotFoundResponse::new);
        UUID testcaseId = UUID.fromString(String.valueOf(session.get("testcaseId")));
        AutomationContracts.FinalizeBody body = ctx.bodyAsClass(AutomationContracts.FinalizeBody.class);

        List<Map<String, Object>> events = AutomationSessionService.listEvents(sessionId, 5000);
        String script = AutomationScriptBuilderService.buildPlaywrightScript(
                body != null ? body.testName : null,
                events
        );
        AutomationSessionService.finalizeIntoTestcase(
                projectId,
                testcaseId,
                userId,
                body != null && body.framework != null ? body.framework : "Playwright",
                body != null ? body.repo : null,
                body != null ? body.path : null,
                body != null && body.testName != null ? body.testName : "Generated Test",
                script
        );
        AutomationSessionService.markSessionEnded(sessionId, "completed");
        AutomationAgentClient.closeSession(sessionId);
        try {
            AuditService.logActivity(userId, projectId, "automation_session_finalized", "testcase", testcaseId.toString(), null);
        } catch (Exception ignored) {}
        ctx.json(Map.of("status", "ok", "script", script));
    }

    public static void cancel(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID sessionId = UUID.fromString(ctx.pathParam("sessionId"));
        Map<String, Object> session = AutomationSessionService.getSession(sessionId, projectId, userId)
                .orElseThrow(io.javalin.http.NotFoundResponse::new);
        UUID testcaseId = UUID.fromString(String.valueOf(session.get("testcaseId")));
        AutomationSessionService.markSessionEnded(sessionId, "cancelled");
        AutomationAgentClient.closeSession(sessionId);
        try {
            AuditService.logActivity(userId, projectId, "automation_session_cancelled", "testcase", testcaseId.toString(), null);
        } catch (Exception ignored) {}
        ctx.status(204);
    }

    private AutomationSessionHandler() {}
}
