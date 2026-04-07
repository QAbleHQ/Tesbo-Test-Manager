package com.bettercases.testexecution;

import com.bettercases.Database;
import com.bettercases.Config;
import com.bettercases.ai.AiHandler;
import com.bettercases.automation.AutomationAgentClient;
import com.bettercases.cycle.CycleService;
import com.bettercases.cycle.ExecutionAutomationReportService;
import com.bettercases.rbac.RbacService;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class CycleAutomationRunService {
    private static final ObjectMapper mapper = new ObjectMapper();

    public static Map<String, Object> executeAutomated(UUID cycleId, UUID userId, boolean strictAutomatedOnly) {
        UUID projectId = CycleService.getProjectIdForCycle(cycleId);
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).orElseThrow().canExecute()) {
            throw new io.javalin.http.ForbiddenResponse("Cannot execute automated test run");
        }
        String cycleStatus = getCycleStatusForAutomation(cycleId);
        if ("Completed".equals(cycleStatus)) {
            throw new io.javalin.http.BadRequestResponse(
                    "Test run is completed and cannot run automated tests");
        }
        return executeAutomatedInternal(cycleId, strictAutomatedOnly);
    }

    public static Map<String, Object> executeAutomatedAsync(UUID cycleId, UUID userId, boolean strictAutomatedOnly) {
        UUID projectId = CycleService.getProjectIdForCycle(cycleId);
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).orElseThrow().canExecute()) {
            throw new io.javalin.http.ForbiddenResponse("Cannot execute automated test run");
        }
        String cycleStatus = getCycleStatusForAutomation(cycleId);
        if ("Completed".equals(cycleStatus)) {
            throw new io.javalin.http.BadRequestResponse(
                    "Test run is completed and cannot run automated tests");
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
        markManualRequiredNotes(rows);
        UUID projectId = CycleService.getProjectIdForCycle(cycleId);
        return ExternalExecutionServiceClient.submitRun(
                cycleId,
                rows,
                automationConfig,
                Config.AUTOMATION_QUEUE_MAX_RETRIES,
                projectId
        );
    }

    public static Map<String, Object> getRunStatus(UUID cycleId, UUID runId, UUID userId) {
        UUID projectId = CycleService.getProjectIdForCycle(cycleId);
        RbacService.requireProjectRole(userId, projectId);
        requireRunBoundToCycle(cycleId, runId);
        return ExternalExecutionServiceClient.getRunStatus(runId.toString());
    }

    public static Map<String, Object> getLatestRunStatus(UUID cycleId, UUID userId) {
        UUID projectId = CycleService.getProjectIdForCycle(cycleId);
        RbacService.requireProjectRole(userId, projectId);
        return ExternalExecutionServiceClient.getLatestRunByExternalRef(cycleId.toString());
    }

    public static void cancelRun(UUID cycleId, UUID runId, UUID userId) {
        UUID projectId = CycleService.getProjectIdForCycle(cycleId);
        RbacService.requireProjectRole(userId, projectId);
        requireRunBoundToCycle(cycleId, runId);
        try {
            ExternalExecutionServiceClient.cancelRun(runId.toString());
        } catch (Exception ignored) {
            // Cancellation on external service is best-effort.
        }
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

    static CycleAutomationConfig resolveCycleAutomationConfig(UUID cycleId) {
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
            ensureSafeStartUrl(startUrl);
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
            return new CycleAutomationConfig(
                    startUrl,
                    executionProvider,
                    maxParallel,
                    providerConfig,
                    provider,
                    modelApiKey,
                    model
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
                return Math.max(1, Math.min(Config.AUTOMATION_QUEUE_MAX_CONCURRENT_JOBS_CEILING, n.intValue()));
            }
            if (maxParallel instanceof String s && !s.isBlank()) {
                try {
                    return Math.max(1, Math.min(Config.AUTOMATION_QUEUE_MAX_CONCURRENT_JOBS_CEILING, Integer.parseInt(s.trim())));
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

    private static void ensureSafeStartUrl(String rawUrl) {
        try {
            URI uri = URI.create(rawUrl);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
            if (!"http".equals(scheme) && !"https".equals(scheme)) {
                throw new io.javalin.http.BadRequestResponse("Automation start URL must use http or https");
            }
            String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase();
            if (host.isBlank()) {
                throw new io.javalin.http.BadRequestResponse("Automation start URL host is required");
            }
            if (host.equals("localhost") || host.endsWith(".local") || host.equals("metadata.google.internal")) {
                throw new io.javalin.http.BadRequestResponse("Automation start URL points to a blocked host");
            }
            if (isPrivateOrLocalIp(host)) {
                throw new io.javalin.http.BadRequestResponse("Automation start URL cannot target private or local network addresses");
            }
        } catch (IllegalArgumentException e) {
            throw new io.javalin.http.BadRequestResponse("Invalid automation start URL");
        }
    }

    private static boolean isPrivateOrLocalIp(String host) {
        if (!host.matches("^\\d+\\.\\d+\\.\\d+\\.\\d+$")) return false;
        String[] parts = host.split("\\.");
        int a = Integer.parseInt(parts[0]);
        int b = Integer.parseInt(parts[1]);
        return a == 10
                || a == 127
                || (a == 169 && b == 254)
                || (a == 172 && b >= 16 && b <= 31)
                || (a == 192 && b == 168);
    }

    private static void requireRunBoundToCycle(UUID cycleId, UUID runId) {
        String sql = """
                SELECT 1
                FROM cycle_automation_runs
                WHERE id = ? AND cycle_id = ?
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, runId);
            ps.setObject(2, cycleId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) {
                throw new io.javalin.http.NotFoundResponse("Automated run not found for this cycle");
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
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
            String model
    ) {}

    private static String getCycleStatusForAutomation(UUID cycleId) {
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("SELECT status FROM cycles WHERE id = ?")) {
            ps.setObject(1, cycleId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) return rs.getString("status");
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        throw new io.javalin.http.NotFoundResponse();
    }

    private CycleAutomationRunService() {
    }
}
