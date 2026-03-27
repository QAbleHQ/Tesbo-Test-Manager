package com.bettercases;

import com.bettercases.admin.AdminHandler;
import com.bettercases.admin.AdminStatsHandler;
import com.bettercases.admin.SystemHealthHandler;
import com.bettercases.auth.AuthHandler;
import com.bettercases.auth.SessionFilter;
import com.bettercases.invitation.InvitationHandler;
import com.bettercases.onboarding.OnboardingHandler;
import com.bettercases.project.ProjectHandler;
import com.bettercases.automation.AutomationSessionHandler;
import com.bettercases.suite.SuiteHandler;
import com.bettercases.tesbo.TesboReportsHandler;
import com.bettercases.testcase.TestCaseHandler;
import com.bettercases.plan.PlanHandler;
import com.bettercases.cycle.CycleHandler;
import com.bettercases.testexecution.ExecutionServiceWebhookHandler;
import com.bettercases.testexecution.CycleScheduleWorker;
import com.bettercases.workspace.WorkspaceHandler;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.javalin.Javalin;
import io.javalin.http.Handler;
import io.javalin.json.JavalinJackson;

public final class Main {
    private static Handler corsHandler() {
        return ctx -> {
            String origin = ctx.header("Origin");
            if (origin != null && Config.CORS_ALLOWED_ORIGINS.contains(origin)) {
                ctx.header("Access-Control-Allow-Origin", origin);
                ctx.header("Vary", "Origin");
                ctx.header("Access-Control-Allow-Credentials", "true");
                ctx.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
                ctx.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
                ctx.header("Access-Control-Max-Age", "86400");
            }
        };
    }
    public static void main(String[] args) {
        Database.getDataSource();

        ObjectMapper mapper = new ObjectMapper();
        SessionFilter sessionFilter = new SessionFilter();
        Javalin app = Javalin.create(c -> {
            c.jsonMapper(new JavalinJackson(mapper, false));
            c.http.maxRequestSize = 10_485_760L; // 10 MB for file uploads
        })
                .before(corsHandler())
                .before(sessionFilter)
                .before(ctx -> ctx.header("X-Request-Id", java.util.UUID.randomUUID().toString()));

        // Handle CORS preflight so OPTIONS returns 204 with CORS headers
        app.options("/*", ctx -> ctx.status(204).result(""));

        app.get("/health", ctx -> ctx.json(java.util.Map.of("status", "ok")));
        app.get("/api/health", ctx -> ctx.json(java.util.Map.of("status", "ok")));

        app.post("/api/auth/otp/request", AuthHandler::requestOtp);
        app.post("/api/auth/otp/verify", AuthHandler::verifyOtp);
        app.post("/api/auth/logout", AuthHandler::logout);
        app.get("/api/auth/me", AuthHandler::me);
        app.get("/api/invitations/{token}", InvitationHandler::getByToken);
        app.post("/api/invitations/{token}/accept", InvitationHandler::acceptByToken);

        app.post("/api/onboarding/workspace", OnboardingHandler::createWorkspace);
        app.post("/api/onboarding/org-and-project", OnboardingHandler::createOrgAndProject);

        app.get("/api/workspace", WorkspaceHandler::get);
        app.get("/api/workspace/analytics", com.bettercases.reporting.ReportingHandler::workspaceAnalytics);
        app.get("/api/workspace/members", WorkspaceHandler::listMembers);
        app.post("/api/workspace/members", WorkspaceHandler::addMember);
        app.delete("/api/workspace/members/{userId}", WorkspaceHandler::removeMember);
        app.get("/api/workspace/project-access", WorkspaceHandler::getProjectAccess);
        app.put("/api/workspace/project-access", WorkspaceHandler::upsertProjectAccess);
        app.delete("/api/workspace/project-access", WorkspaceHandler::removeProjectAccess);
        app.get("/api/workspace/ai-keys", WorkspaceHandler::listAiKeys);
        app.post("/api/workspace/ai-keys", WorkspaceHandler::createAiKey);
        app.delete("/api/workspace/ai-keys/{keyId}", WorkspaceHandler::deleteAiKey);
        app.post("/api/workspace/ai-keys/allocations", WorkspaceHandler::allocateAiKeyToProject);
        app.get("/api/workspace/invitations", InvitationHandler::listWorkspaceInvitations);
        app.post("/api/workspace/invitations", InvitationHandler::createWorkspaceInvitation);
        app.delete("/api/workspace/invitations/{id}", InvitationHandler::revokeWorkspaceInvitation);

        app.get("/api/projects", ProjectHandler::list);
        app.post("/api/projects", ProjectHandler::create);
        app.get("/api/projects/{id}", ProjectHandler::get);
        app.patch("/api/projects/{id}", ProjectHandler::update);
        app.delete("/api/projects/{id}", ProjectHandler::delete);
        app.get("/api/projects/{id}/members", ProjectHandler::listMembers);
        app.post("/api/projects/{id}/members", ProjectHandler::addMember);
        app.delete("/api/projects/{id}/members/{userId}", ProjectHandler::removeMember);
        app.get("/api/projects/{id}/apikeys", ProjectHandler::listApiKeys);
        app.post("/api/projects/{id}/apikeys", ProjectHandler::createApiKey);
        app.delete("/api/projects/{id}/apikeys/{keyId}", ProjectHandler::revokeApiKey);

        app.get("/api/projects/{projectId}/suites", SuiteHandler::listTree);
        app.post("/api/projects/{projectId}/suites", SuiteHandler::create);
        app.patch("/api/suites/{suiteId}", SuiteHandler::update);
        app.delete("/api/suites/{suiteId}", SuiteHandler::delete);

        app.get("/api/projects/{projectId}/testcases", TestCaseHandler::list);
        app.post("/api/projects/{projectId}/testcases", TestCaseHandler::create);
        app.get("/api/projects/{projectId}/testcases/{testcaseId}", TestCaseHandler::get);
        app.put("/api/projects/{projectId}/testcases/{testcaseId}", TestCaseHandler::update);
        app.delete("/api/projects/{projectId}/testcases/{testcaseId}", TestCaseHandler::delete);
        app.post("/api/projects/{projectId}/testcases/bulk-update", com.bettercases.testcase.BulkUpdateHandler::bulkUpdate);
        app.post("/api/projects/{projectId}/testcases/bulk-delete", com.bettercases.testcase.BulkUpdateHandler::bulkDelete);
        app.get("/api/projects/{projectId}/testcases/linked-jira-keys", TestCaseHandler::linkedJiraKeys);
        app.post("/api/projects/{projectId}/testcases/{testcaseId}/automation/sessions", AutomationSessionHandler::start);
        app.post("/api/projects/{projectId}/automation/sessions/{sessionId}/commands", AutomationSessionHandler::runCommand);
        app.post("/api/projects/{projectId}/automation/sessions/{sessionId}/commands/stop", AutomationSessionHandler::stopActiveCommand);
        app.get("/api/projects/{projectId}/automation/sessions/{sessionId}", AutomationSessionHandler::getSession);
        app.get("/api/projects/{projectId}/automation/sessions/{sessionId}/stream", AutomationSessionHandler::stream);
        app.get("/api/projects/{projectId}/automation/sessions/{sessionId}/live", AutomationSessionHandler::live);
        app.get("/api/projects/{projectId}/automation/sessions/{sessionId}/trace", AutomationSessionHandler::downloadLatestTrace);
        app.post("/api/projects/{projectId}/automation/sessions/{sessionId}/reset", AutomationSessionHandler::reset);
        app.post("/api/projects/{projectId}/automation/sessions/{sessionId}/finalize", AutomationSessionHandler::finalizeSession);
        app.post("/api/projects/{projectId}/automation/sessions/{sessionId}/cancel", AutomationSessionHandler::cancel);
        app.post("/api/projects/{projectId}/automation/sessions/{sessionId}/manual-actions", AutomationSessionHandler::manualAction);
        app.post("/api/projects/{projectId}/automation/sessions/{sessionId}/run-script", AutomationSessionHandler::runPlaywrightScript);
        app.get("/api/projects/{projectId}/automation/sessions/{sessionId}/recording", AutomationSessionHandler::getRecording);
        app.post("/api/projects/{projectId}/automation/sessions/{sessionId}/recording/compile", AutomationSessionHandler::compileRecording);
        app.get("/api/projects/{projectId}/automation/recordings", AutomationSessionHandler::listRecordingsByProject);
        app.get("/api/projects/{projectId}/automation/recordings/{recordingId}", AutomationSessionHandler::getRecordingById);
        app.get("/api/projects/{projectId}/testcases/{testcaseId}/automation/recordings", AutomationSessionHandler::listRecordingsByTestcase);

        app.get("/api/projects/{projectId}/plans", PlanHandler::list);
        app.post("/api/projects/{projectId}/plans", PlanHandler::create);
        app.get("/api/plans/{planId}", PlanHandler::get);
        app.patch("/api/plans/{planId}", PlanHandler::update);
        app.delete("/api/plans/{planId}", PlanHandler::delete);
        app.get("/api/plans/{planId}/items", PlanHandler::listItems);
        app.post("/api/plans/{planId}/items", PlanHandler::addItem);
        app.delete("/api/plans/{planId}/items/{itemId}", PlanHandler::removeItem);
        app.get("/api/plans/{planId}/runs", PlanHandler::listRuns);
        app.get("/api/plans/{planId}/progress", PlanHandler::getProgress);

        app.get("/api/projects/{projectId}/cycles", CycleHandler::list);
        app.post("/api/projects/{projectId}/cycles", CycleHandler::create);
        app.post("/api/projects/{projectId}/cycles/from-plan", CycleHandler::createFromPlan);
        app.post("/api/projects/{projectId}/cycles/from-cases", CycleHandler::createFromCases);
        app.get("/api/cycles/{cycleId}", CycleHandler::get);
        app.patch("/api/cycles/{cycleId}", CycleHandler::update);
        app.delete("/api/cycles/{cycleId}", CycleHandler::delete);
        app.post("/api/cycles/{cycleId}/testcases", CycleHandler::addTestCases);
        app.delete("/api/cycles/{cycleId}/testcases/{testcaseId}", CycleHandler::removeTestCase);
        app.get("/api/cycles/{cycleId}/executions", CycleHandler::listExecutions);
        app.patch("/api/cycles/{cycleId}/executions/{executionId}", CycleHandler::updateExecution);
        app.get("/api/cycles/{cycleId}/executions/{executionId}/automation-report", CycleHandler::getExecutionAutomationReport);
        app.get("/api/cycles/{cycleId}/executions/{executionId}/automation-video", CycleHandler::streamExecutionAutomationVideo);
        app.get("/api/cycles/{cycleId}/executions/{executionId}/automation-trace", CycleHandler::streamExecutionAutomationTrace);
        app.post("/api/cycles/{cycleId}/executions/bulk-assign", CycleHandler::bulkAssign);
        app.post("/api/cycles/{cycleId}/executions/bulk-status", CycleHandler::bulkUpdateStatus);
        app.post("/api/cycles/{cycleId}/execute-automated", CycleHandler::executeAutomated);
        app.get("/api/cycles/{cycleId}/execute-automated/latest/status", CycleHandler::getLatestAutomatedRunStatus);
        app.get("/api/cycles/{cycleId}/execute-automated/{runId}/status", CycleHandler::getAutomatedRunStatus);
        app.post("/api/cycles/{cycleId}/execute-automated/{runId}/cancel", CycleHandler::cancelAutomatedRun);
        app.post("/api/cycles/{cycleId}/share", CycleHandler::toggleShare);
        app.get("/api/projects/{projectId}/cycles/schedules", CycleHandler::listSchedules);
        app.post("/api/projects/{projectId}/cycles/schedules", CycleHandler::createSchedule);
        app.patch("/api/cycles/schedules/{scheduleId}", CycleHandler::updateSchedule);
        app.delete("/api/cycles/schedules/{scheduleId}", CycleHandler::deleteSchedule);

        // Public sharing endpoints (no authentication required)
        app.get("/api/public/shared-runs/{token}", CycleHandler::getPublicRun);
        app.get("/api/public/shared-runs/{token}/executions", CycleHandler::getPublicExecutions);

        // Execution Service webhook endpoint
        app.post("/api/webhooks/execution-service", ExecutionServiceWebhookHandler::handle);

        app.get("/api/projects/{projectId}/bugs", com.bettercases.bug.BugHandler::list);
        app.post("/api/projects/{projectId}/bugs", com.bettercases.bug.BugHandler::create);
        app.get("/api/bugs/{bugId}", com.bettercases.bug.BugHandler::get);
        app.patch("/api/bugs/{bugId}", com.bettercases.bug.BugHandler::update);
        app.delete("/api/bugs/{bugId}", com.bettercases.bug.BugHandler::delete);

        app.get("/api/projects/{projectId}/testcases/export/csv", com.bettercases.export.ExportHandler::exportCasesCsv);
        app.get("/api/projects/{projectId}/testcases/export/xlsx", com.bettercases.export.ExportHandler::exportCasesXlsx);
        app.get("/api/projects/{projectId}/testcases/import/template", com.bettercases.export.ImportHandler::downloadTemplate);
        app.post("/api/projects/{projectId}/testcases/import/preview", com.bettercases.export.ImportHandler::preview);
        app.post("/api/projects/{projectId}/testcases/import", com.bettercases.export.ImportHandler::execute);
        app.get("/api/cycles/{cycleId}/export/csv", com.bettercases.export.ExportHandler::exportCycleCsv);

        app.get("/api/projects/{projectId}/analytics", com.bettercases.reporting.ReportingHandler::projectAnalytics);
        app.get("/api/cycles/{cycleId}/report/summary", com.bettercases.reporting.ReportingHandler::cycleSummary);
        app.get("/api/projects/{projectId}/reports/execution", com.bettercases.reporting.ReportingHandler::executionReport);
        app.get("/api/projects/{projectId}/reports/requirement-matrix", com.bettercases.reporting.ReportingHandler::requirementMatrix);
        app.get("/api/projects/{projectId}/reports/repository-summary", com.bettercases.reporting.ReportingHandler::repositorySummary);

        app.post("/api/projects/{projectId}/ai/generate-testcases", com.bettercases.ai.AiHandler::generateTestCases);
        app.post("/api/projects/{projectId}/ai/review-script", com.bettercases.ai.AiHandler::reviewScript);
        app.get("/api/projects/{projectId}/ai/generation-history", com.bettercases.ai.AiHandler::listHistory);
        app.post("/api/projects/{projectId}/ai/generation-history/{requestId}/save", com.bettercases.ai.AiHandler::trackSave);

        // Knowledge Base
        app.get("/api/projects/{projectId}/knowledge-base", com.bettercases.knowledgebase.KnowledgeBaseHandler::list);
        app.post("/api/projects/{projectId}/knowledge-base", com.bettercases.knowledgebase.KnowledgeBaseHandler::createNote);
        app.post("/api/projects/{projectId}/knowledge-base/upload", com.bettercases.knowledgebase.KnowledgeBaseHandler::upload);
        app.get("/api/projects/{projectId}/knowledge-base/{itemId}", com.bettercases.knowledgebase.KnowledgeBaseHandler::get);
        app.patch("/api/projects/{projectId}/knowledge-base/{itemId}", com.bettercases.knowledgebase.KnowledgeBaseHandler::update);
        app.delete("/api/projects/{projectId}/knowledge-base/{itemId}", com.bettercases.knowledgebase.KnowledgeBaseHandler::delete);
        app.get("/api/projects/{projectId}/knowledge-base/{itemId}/file", com.bettercases.knowledgebase.KnowledgeBaseHandler::downloadFile);

        // Jira integration
        app.get("/api/projects/{projectId}/jira/auth-url", com.bettercases.jira.JiraHandler::authUrl);
        app.post("/api/projects/{projectId}/jira/callback", com.bettercases.jira.JiraHandler::callback);
        app.get("/api/projects/{projectId}/jira/status", com.bettercases.jira.JiraHandler::status);
        app.delete("/api/projects/{projectId}/jira/disconnect", com.bettercases.jira.JiraHandler::disconnect);
        app.get("/api/projects/{projectId}/jira/projects", com.bettercases.jira.JiraHandler::listJiraProjects);
        app.post("/api/projects/{projectId}/jira/projects", com.bettercases.jira.JiraHandler::connectProjects);
        app.post("/api/projects/{projectId}/jira/sync", com.bettercases.jira.JiraHandler::sync);
        app.get("/api/projects/{projectId}/jira/tickets", com.bettercases.jira.JiraHandler::listTickets);
        app.post("/api/projects/{projectId}/jira/comment", com.bettercases.jira.JiraHandler::addComment);

        // Activity feed
        app.get("/api/projects/{projectId}/activity", com.bettercases.audit.ActivityHandler::list);

        app.get("/api/notifications", com.bettercases.notifications.NotificationHandler::list);
        app.post("/api/notifications/{id}/read", com.bettercases.notifications.NotificationHandler::markRead);

        // Tesbo Reports (embedded module)
        app.get("/api/projects/{projectId}/tesbo-reports/runs", TesboReportsHandler::listRuns);
        app.get("/api/projects/{projectId}/tesbo-reports/runs/{runId}", TesboReportsHandler::getRun);
        app.get("/api/projects/{projectId}/tesbo-reports/specs", TesboReportsHandler::listSpecs);
        app.get("/api/projects/{projectId}/tesbo-reports/specs/{specName}", TesboReportsHandler::getSpec);
        app.get("/api/projects/{projectId}/tesbo-reports/specs/{specName}/tests/{testName}", TesboReportsHandler::getTestHistory);
        app.get("/api/projects/{projectId}/tesbo-reports/tests", TesboReportsHandler::listTests);
        app.get("/api/projects/{projectId}/tesbo-reports/analytics", TesboReportsHandler::analytics);
        app.get("/api/projects/{projectId}/tesbo-reports/alerts", TesboReportsHandler::listAlerts);
        app.post("/api/projects/{projectId}/tesbo-reports/alerts", TesboReportsHandler::createAlert);
        app.put("/api/projects/{projectId}/tesbo-reports/alerts/{alertId}", TesboReportsHandler::updateAlert);
        app.delete("/api/projects/{projectId}/tesbo-reports/alerts/{alertId}", TesboReportsHandler::deleteAlert);
        app.post("/api/projects/{projectId}/tesbo-reports/alerts/{alertId}/toggle", TesboReportsHandler::toggleAlert);
        app.post("/api/projects/{projectId}/tesbo-reports/alerts/{alertId}/send-test", TesboReportsHandler::sendTestAlert);
        app.get("/api/projects/{projectId}/tesbo-reports/runs/{runId}/share", TesboReportsHandler::getShare);
        app.post("/api/projects/{projectId}/tesbo-reports/runs/{runId}/share", TesboReportsHandler::createShare);
        app.delete("/api/projects/{projectId}/tesbo-reports/runs/{runId}/share", TesboReportsHandler::disableShare);
        app.get("/api/projects/{projectId}/tesbo-reports/settings", TesboReportsHandler::getSettings);
        app.put("/api/projects/{projectId}/tesbo-reports/settings", TesboReportsHandler::updateSettings);
        app.post("/api/projects/{projectId}/tesbo-reports/settings/rotate-key", TesboReportsHandler::rotateIngestionKey);
        app.post("/api/projects/{projectId}/tesbo-reports/ingest/playwright", TesboReportsHandler::ingestPlaywright);
        app.post("/api/projects/{projectId}/tesbo-reports/ingest/playwright/upload", TesboReportsHandler::ingestPlaywrightFile);
        app.post("/api/projects/{projectId}/tesbo-reports/runs/{runId}/cases/{caseId}/artifacts/{kind}/upload", TesboReportsHandler::uploadCaseArtifact);
        app.get("/api/projects/{projectId}/tesbo-reports/cases/{caseId}/artifacts/{kind}", TesboReportsHandler::getCaseArtifact);
        app.post("/api/tesbo-reports/ingest/playwright", TesboReportsHandler::ingestPlaywrightByKey);
        app.post("/api/tesbo-reports/ingest/playwright/upload", TesboReportsHandler::ingestPlaywrightFileByKey);
        app.post("/api/tesbo-reports/runs/{runId}/cases/{caseId}/artifacts/{kind}/upload", TesboReportsHandler::uploadCaseArtifactByKey);
        app.get("/api/public/tesbo-reports/{token}", TesboReportsHandler::getPublicSharedRun);
        app.get("/api/public/tesbo-reports/{token}/cases/{caseId}/artifacts/{kind}", TesboReportsHandler::getPublicSharedArtifact);

        // Platform Admin Panel
        app.get("/api/admin/system/health", SystemHealthHandler::check);
        app.get("/api/admin/customers", AdminStatsHandler::listCustomers);
        app.get("/api/admin/admins", AdminHandler::listAdmins);
        app.post("/api/admin/admins", AdminHandler::addAdmin);
        app.delete("/api/admin/admins/{adminId}", AdminHandler::removeAdmin);

        // Log unhandled exceptions and return 500 with JSON (avoids empty 500 in browser)
        app.exception(Exception.class, (e, ctx) -> {
            System.err.println("Unhandled exception for " + ctx.method() + " " + ctx.path() + ":");
            e.printStackTrace(System.err);
            ctx.status(500).json(java.util.Map.of("error", "Internal server error"));
        });

        CycleScheduleWorker.start();
        app.start(Config.SERVER_PORT);
        System.out.println("Backend running on http://localhost:" + Config.SERVER_PORT);
    }
}
