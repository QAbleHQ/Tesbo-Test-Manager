package com.bettercases.cycle;

import com.bettercases.Database;
import com.bettercases.Config;
import com.bettercases.ai.AiHandler;
import com.bettercases.automation.AutomationAgentClient;
import com.bettercases.automation.BrowserbaseCredentialsService;
import com.bettercases.rbac.RbacService;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class CycleAutomationRunService {
    private static final ExecutorService RUNNER_EXECUTOR = Executors.newCachedThreadPool();
    private static final ObjectMapper mapper = new ObjectMapper();

    public static Map<String, Object> executeAutomated(UUID cycleId, UUID userId, boolean strictAutomatedOnly) {
        UUID projectId = CycleService.getProjectIdForCycle(cycleId);
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).orElseThrow().canExecute()) {
            throw new io.javalin.http.ForbiddenResponse("Cannot execute automated test run");
        }
        return executeAutomatedInternal(cycleId, strictAutomatedOnly);
    }

    public static Map<String, Object> executeAutomatedAsync(UUID cycleId, UUID userId, boolean strictAutomatedOnly) {
        UUID projectId = CycleService.getProjectIdForCycle(cycleId);
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).orElseThrow().canExecute()) {
            throw new io.javalin.http.ForbiddenResponse("Cannot execute automated test run");
        }
        return executeAutomatedAsyncInternal(cycleId, strictAutomatedOnly);
    }

    static Map<String, Object> executeAutomatedAsyncInternal(UUID cycleId, boolean strictAutomatedOnly) {
        if (strictAutomatedOnly) {
            List<String> violations = validateAutomatedOnly(cycleId);
            if (!violations.isEmpty()) {
                throw new io.javalin.http.BadRequestResponse(
                        "Scheduled run requires automated-only test cases. Missing scripts: " + String.join(", ", violations)
                );
            }
        }
        List<ExecutionScriptRow> rows = loadExecutionRows(cycleId);
        CycleAutomationConfig automationConfig = resolveCycleAutomationConfig(cycleId);
        if (rows.stream().noneMatch(r -> r.script() != null && !r.script().isBlank())) {
            throw new io.javalin.http.BadRequestResponse("No automated test cases found in this test run.");
        }
        if ("queue".equals(Config.AUTOMATION_EXECUTION_MODE)) {
            assertQueueExecutionAvailable();
            markManualRequiredNotes(rows);
            return AutomationExecutionOrchestratorService.enqueueRun(
                    cycleId,
                    rows,
                    automationConfig,
                    Config.AUTOMATION_QUEUE_MAX_RETRIES
            );
        }
        UUID runId = CycleAutomationRunTracker.start(cycleId, rows);
        RUNNER_EXECUTOR.submit(() -> {
            try {
                runRows(cycleId, strictAutomatedOnly, rows, runId, automationConfig);
                CycleAutomationRunTracker.complete(runId);
            } catch (Exception e) {
                CycleAutomationRunTracker.fail(runId, e.getMessage());
            }
        });
        return Map.of(
                "runId", runId.toString(),
                "cycleId", cycleId.toString(),
                "status", "running",
                "totalCases", rows.size()
        );
    }

    public static Map<String, Object> getRunStatus(UUID cycleId, UUID runId, UUID userId) {
        UUID projectId = CycleService.getProjectIdForCycle(cycleId);
        RbacService.requireProjectRole(userId, projectId);
        if (AutomationExecutionQueueService.exists(cycleId, runId)) {
            return AutomationExecutionQueueService.snapshot(cycleId, runId);
        }
        return CycleAutomationRunTracker.snapshot(cycleId, runId);
    }

    public static Map<String, Object> getLatestRunStatus(UUID cycleId, UUID userId) {
        UUID projectId = CycleService.getProjectIdForCycle(cycleId);
        RbacService.requireProjectRole(userId, projectId);
        UUID runId = AutomationExecutionQueueService.findLatestRunId(cycleId);
        if (runId == null) {
            throw new io.javalin.http.NotFoundResponse("No automated run found.");
        }
        return AutomationExecutionQueueService.snapshot(cycleId, runId);
    }

    public static void cancelRun(UUID cycleId, UUID runId, UUID userId) {
        UUID projectId = CycleService.getProjectIdForCycle(cycleId);
        RbacService.requireProjectRole(userId, projectId);
        if ("queue".equals(Config.AUTOMATION_EXECUTION_MODE) && AutomationExecutionQueueService.exists(cycleId, runId)) {
            AutomationExecutionQueueService.cancelRun(cycleId, runId, "Cancelled by user");
            try {
                AutomationAgentClient.cancelRunQueue(runId);
            } catch (Exception ignored) {
                // Cancellation in queue backend is best-effort.
            }
            return;
        }
        throw new io.javalin.http.BadRequestResponse("Run cancellation is not available for legacy mode.");
    }

    static Map<String, Object> executeAutomatedInternal(UUID cycleId, boolean strictAutomatedOnly) {
        if (strictAutomatedOnly) {
            List<String> violations = validateAutomatedOnly(cycleId);
            if (!violations.isEmpty()) {
                throw new io.javalin.http.BadRequestResponse(
                        "Scheduled run requires automated-only test cases. Missing scripts: " + String.join(", ", violations)
                );
            }
        }
        List<ExecutionScriptRow> rows = loadExecutionRows(cycleId);
        CycleAutomationConfig automationConfig = resolveCycleAutomationConfig(cycleId);
        if (rows.stream().noneMatch(r -> r.script() != null && !r.script().isBlank())) {
            throw new io.javalin.http.BadRequestResponse("No automated test cases found in this test run.");
        }
        return runRows(cycleId, strictAutomatedOnly, rows, null, automationConfig);
    }

    private static Map<String, Object> runRows(UUID cycleId, boolean strictAutomatedOnly, List<ExecutionScriptRow> rows, UUID runId, CycleAutomationConfig automationConfig) {
        String startUrl = automationConfig.startUrl();
        int total = rows.size();
        int automated = 0;
        int passed = 0;
        int failed = 0;
        int manual = 0;
        for (ExecutionScriptRow row : rows) {
            if (row.script() == null || row.script().isBlank()) {
                manual++;
                markManualRequiredNote(row.executionId());
                if (runId != null) {
                    CycleAutomationRunTracker.markResult(runId, row.executionId(), "manual", "Manual execution required (no linked automation script).");
                }
                ExecutionAutomationReportService.upsert(
                        cycleId, row.executionId(), "manual", Instant.now().toString(), Instant.now().toString(),
                        List.of(), null, null, null, "Manual execution required (no linked automation script)."
                );
                continue;
            }
            automated++;
            String startedAt = Instant.now().toString();
            if (runId != null) {
                CycleAutomationRunTracker.markCurrent(runId, row.executionId(), "running", "Executing script...");
            }
            List<Map<String, Object>> reportLogs = List.of();
            String reportStatus = "failed";
            String reportError = null;
            String reportScreenshot = null;
            String reportVideo = null;
            String reportTrace = null;
            try {
                Map<String, Object> response = AutomationAgentClient.runPlaywrightScript(
                        row.executionId(),
                        row.script(),
                        startUrl,
                        automationConfig.modelProvider(),
                        automationConfig.modelApiKey(),
                        automationConfig.model(),
                        automationConfig.browserbaseApiKey(),
                        automationConfig.browserbaseProjectId(),
                        cycleId + "/" + row.executionId()
                );
                @SuppressWarnings("unchecked")
                List<Map<String, Object>> logs = response.get("logs") instanceof List<?> l ? (List<Map<String, Object>>) l : List.of();
                reportLogs = logs;
                String status = response.get("status") instanceof String s ? s : "failed";
                boolean ok = "passed".equalsIgnoreCase(status);
                reportScreenshot = response.get("screenshotPath") instanceof String s ? s : null;
                reportVideo = response.get("videoPath") instanceof String s ? s : null;
                reportTrace = response.get("tracePath") instanceof String s ? s : null;
                String errorMessage = response.get("errorMessage") instanceof String s ? s : null;
                if (ok) {
                    passed++;
                    reportStatus = "passed";
                    String message = "Automated run passed.";
                    if (reportScreenshot != null && !reportScreenshot.isBlank()) {
                        message += " Screenshot: " + reportScreenshot;
                    }
                    markExecution(row.executionId(), "Passed", message);
                    if (runId != null) {
                        CycleAutomationRunTracker.markResult(runId, row.executionId(), "passed", message);
                    }
                } else {
                    failed++;
                    String failureMessage = (errorMessage != null && !errorMessage.isBlank())
                            ? "Automated run failed: " + errorMessage
                            : "Automated run failed.";
                    reportError = failureMessage;
                    markExecution(row.executionId(), "Failed", failureMessage);
                    if (runId != null) {
                        CycleAutomationRunTracker.markResult(runId, row.executionId(), "failed", failureMessage);
                    }
                }
            } catch (Exception e) {
                failed++;
                reportError = "Automated run failed: " + e.getMessage();
                markExecution(row.executionId(), "Failed", reportError);
                if (runId != null) {
                    CycleAutomationRunTracker.markResult(runId, row.executionId(), "failed", reportError);
                }
            } finally {
                ExecutionAutomationReportService.upsert(
                        cycleId,
                        row.executionId(),
                        reportStatus,
                        startedAt,
                        Instant.now().toString(),
                        reportLogs,
                        reportVideo,
                        reportScreenshot,
                        reportTrace,
                        reportError
                );
            }
        }
        return Map.of(
                "cycleId", cycleId.toString(),
                "totalCases", total,
                "automatedCases", automated,
                "manualCases", manual,
                "passed", passed,
                "failed", failed,
                "completedAt", Instant.now().toString()
        );
    }

    private static void assertQueueExecutionAvailable() {
        try {
            AutomationAgentClient.queueStats();
        } catch (Exception e) {
            throw new io.javalin.http.ServiceUnavailableResponse(
                    "Automation queue worker is unavailable. Start automation-agent with queue enabled."
            );
        }
    }

    private static CycleAutomationConfig resolveCycleAutomationConfig(UUID cycleId) {
        String sql = """
                SELECT c.environment, c.project_id, p.settings
                FROM cycles c
                JOIN projects p ON p.id = c.project_id
                WHERE c.id = ?
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, cycleId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) {
                throw new io.javalin.http.NotFoundResponse();
            }
            String environment = rs.getString("environment");
            if (environment == null || environment.isBlank()) {
                throw new io.javalin.http.BadRequestResponse("Test run environment is not set.");
            }
            String environmentValue = environment.trim();
            String settingsRaw = rs.getString("settings");
            Map<String, Object> settings = parseSettings(settingsRaw);
            String startUrl;
            if (looksLikeUrl(environmentValue)) {
                startUrl = environmentValue;
            } else {
                String resolved = resolveEnvironmentUrlFromSettings(settings, environmentValue);
                if (resolved == null || resolved.isBlank()) {
                    throw new io.javalin.http.BadRequestResponse(
                            "Selected environment \"" + environmentValue + "\" does not have a configured URL."
                    );
                }
                startUrl = resolved;
            }
            String executionProvider = resolveExecutionProvider(settings);
            int maxParallel = resolveMaxParallel(settings);
            Map<String, Object> providerConfig = resolveProviderConfig(settings, executionProvider);
            UUID projectId = (UUID) rs.getObject("project_id");
            Map<String, String> aiConfig = AiHandler.readAiConfig(projectId);
            String provider = String.valueOf(aiConfig.getOrDefault("provider", "openai")).trim().toLowerCase();
            if (!"anthropic".equals(provider)) provider = "openai";
            String modelApiKey = "anthropic".equals(provider)
                    ? String.valueOf(aiConfig.getOrDefault("anthropicApiKey", "")).trim()
                    : String.valueOf(aiConfig.getOrDefault("openAiApiKey", "")).trim();
            String model = String.valueOf(aiConfig.getOrDefault("model", "")).trim();
            BrowserbaseCredentialsService.Credentials browserbase = BrowserbaseCredentialsService.resolve(projectId);
            return new CycleAutomationConfig(
                    startUrl,
                    executionProvider,
                    maxParallel,
                    providerConfig,
                    provider,
                    modelApiKey,
                    model,
                    browserbase.apiKey(),
                    browserbase.projectId()
            );
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static Map<String, Object> parseSettings(String settingsRaw) {
        if (settingsRaw == null || settingsRaw.isBlank()) return Map.of();
        try {
            return mapper.readValue(settingsRaw, new TypeReference<>() {});
        } catch (Exception e) {
            throw new RuntimeException("Failed to read project test environment settings", e);
        }
    }

    private static String resolveEnvironmentUrlFromSettings(Map<String, Object> settings, String environmentName) {
        Object rawEnvironments = settings.get("testRunEnvironments");
        if (!(rawEnvironments instanceof List<?> list)) return null;
        for (Object item : list) {
            if (!(item instanceof Map<?, ?> envMap)) continue;
            Object name = envMap.get("name");
            Object url = envMap.get("url");
            if (!(name instanceof String nameStr) || !(url instanceof String urlStr)) continue;
            if (environmentName.equalsIgnoreCase(nameStr.trim())) {
                String trimmedUrl = urlStr.trim();
                if (!trimmedUrl.isBlank()) {
                    return trimmedUrl;
                }
            }
        }
        return null;
    }

    private static String resolveExecutionProvider(Map<String, Object> settings) {
        Object automationObject = settings.get("automation");
        if (automationObject instanceof Map<?, ?> automationMap) {
            Object provider = automationMap.get("executionProvider");
            if (provider instanceof String s && !s.isBlank()) {
                String normalized = s.trim().toLowerCase();
                if ("lambdatest".equals(normalized) || "browserstack".equals(normalized)) {
                    return normalized;
                }
            }
        }
        return "default";
    }

    private static int resolveMaxParallel(Map<String, Object> settings) {
        Object automationObject = settings.get("automation");
        if (automationObject instanceof Map<?, ?> automationMap) {
            Object maxParallel = automationMap.get("maxParallel");
            if (maxParallel instanceof Number n) {
                return Math.max(1, Math.min(50, n.intValue()));
            }
            if (maxParallel instanceof String s && !s.isBlank()) {
                try {
                    return Math.max(1, Math.min(50, Integer.parseInt(s.trim())));
                } catch (NumberFormatException ignored) {
                    // ignore malformed values
                }
            }
        }
        return 1;
    }

    private static Map<String, Object> resolveProviderConfig(Map<String, Object> settings, String executionProvider) {
        Object automationObject = settings.get("automation");
        if (!(automationObject instanceof Map<?, ?> automationMap)) return Map.of();
        Object providersObject = automationMap.get("providers");
        if (!(providersObject instanceof Map<?, ?> providersMap)) return Map.of();
        Object selected = providersMap.get(executionProvider);
        if (!(selected instanceof Map<?, ?> selectedMap)) return Map.of();
        return selectedMap.entrySet().stream()
                .filter(e -> e.getKey() instanceof String)
                .collect(java.util.stream.Collectors.toMap(
                        e -> (String) e.getKey(),
                        Map.Entry::getValue
                ));
    }

    private static boolean looksLikeUrl(String value) {
        String lower = value.toLowerCase();
        return lower.startsWith("http://") || lower.startsWith("https://");
    }

    public static List<String> validateAutomatedOnly(UUID cycleId) {
        String sql = """
                SELECT tc.external_id, tc.title
                FROM cycle_items ci
                JOIN testcases tc ON tc.id = ci.testcase_id
                WHERE ci.cycle_id = ?
                  AND (tc.automation_script IS NULL OR btrim(tc.automation_script) = '')
                ORDER BY ci.position
                """;
        List<String> out = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, cycleId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                String externalId = rs.getString("external_id");
                String title = rs.getString("title");
                if (externalId == null || externalId.isBlank()) out.add(title);
                else out.add(externalId + " - " + title);
            }
            return out;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static List<ExecutionScriptRow> loadExecutionRows(UUID cycleId) {
        String sql = """
                SELECT e.id AS execution_id, tc.automation_script, ci.snapshot_title AS title, tc.external_id
                FROM cycle_items ci
                JOIN executions e ON e.cycle_item_id = ci.id
                JOIN testcases tc ON tc.id = ci.testcase_id
                WHERE ci.cycle_id = ?
                ORDER BY ci.position
                """;
        List<ExecutionScriptRow> out = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, cycleId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                out.add(new ExecutionScriptRow(
                        (UUID) rs.getObject("execution_id"),
                        rs.getString("automation_script"),
                        rs.getString("title"),
                        rs.getString("external_id")
                ));
            }
            return out;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static void markExecution(UUID executionId, String status, String resultText) {
        String sql = """
                UPDATE executions
                SET status = ?, actual_result = ?, executed_at = now(), updated_at = now()
                WHERE id = ?
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, status);
            ps.setString(2, resultText);
            ps.setObject(3, executionId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static void markManualRequiredNotes(List<ExecutionScriptRow> rows) {
        for (ExecutionScriptRow row : rows) {
            if (row.script() == null || row.script().isBlank()) {
                markManualRequiredNote(row.executionId());
            }
        }
    }

    private static void markManualRequiredNote(UUID executionId) {
        String sql = """
                UPDATE executions
                SET actual_result = ?, updated_at = now()
                WHERE id = ?
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, "Manual execution required (no linked automation script).");
            ps.setObject(2, executionId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public record ExecutionScriptRow(UUID executionId, String script, String title, String externalId) {}

    public record CycleAutomationConfig(
            String startUrl,
            String executionProvider,
            int maxParallel,
            Map<String, Object> providerConfig,
            String modelProvider,
            String modelApiKey,
            String model,
            String browserbaseApiKey,
            String browserbaseProjectId
    ) {}

    private CycleAutomationRunService() {
    }
}
