package com.bettercases.testexecution;

import com.bettercases.Config;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * HTTP client for the TesboX-Executions API.
 * Used in "external" execution mode as a replacement for direct queue orchestration.
 */
public final class ExternalExecutionServiceClient {
    private static final HttpClient client = HttpClient.newHttpClient();
    private static final ObjectMapper mapper = new ObjectMapper();

    private static String executionServiceBaseUrl() {
        String base = Config.EXECUTION_SERVICE_BASE_URL == null ? "" : Config.EXECUTION_SERVICE_BASE_URL.trim();
        while (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        if (base.isBlank()) {
            throw new IllegalStateException("EXECUTION_SERVICE_BASE_URL is empty; set it to the execution API base (e.g. https://exe.tesbo.io)");
        }
        return base;
    }

    /**
     * Submit a new execution run to the external Execution Service.
     */
    public static Map<String, Object> submitRun(
            UUID cycleId,
            List<CycleAutomationRunService.ExecutionScriptRow> rows,
            CycleAutomationRunService.CycleAutomationConfig automationConfig,
            int maxRetries,
            UUID projectId
    ) {
        List<Map<String, Object>> jobs = new ArrayList<>();
        for (CycleAutomationRunService.ExecutionScriptRow row : rows) {
            Map<String, Object> job = new LinkedHashMap<>();
            job.put("script", row.script());
            job.put("externalRef", row.executionId().toString());
            job.put("title", row.title());
            job.put("startUrl", automationConfig.startUrl());
            job.put("maxRetries", maxRetries);
            jobs.add(job);
        }

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("jobs", jobs);
        payload.put("externalRef", cycleId.toString());
        payload.put("projectId", projectId.toString());
        payload.put("maxParallel", automationConfig.maxParallel());
        payload.put("executionProvider", automationConfig.executionProvider());
        payload.put("providerConfig", automationConfig.providerConfig());
        payload.put("modelProvider", automationConfig.modelProvider());
        payload.put("modelApiKey", automationConfig.modelApiKey());
        payload.put("model", automationConfig.model());

        String webhookUrl = Config.EXECUTION_SERVICE_WEBHOOK_URL;
        if (webhookUrl != null && !webhookUrl.isBlank()) {
            payload.put("webhookUrl", webhookUrl);
            String webhookSecret = Config.EXECUTION_SERVICE_WEBHOOK_SECRET;
            if (webhookSecret != null && !webhookSecret.isBlank()) {
                payload.put("webhookSecret", webhookSecret);
            }
        }

        return sendPost("/api/runs", payload);
    }

    /**
     * Get run status from the external Execution Service.
     */
    public static Map<String, Object> getRunStatus(String runId) {
        return sendGet("/api/runs/" + runId);
    }

    /**
     * Get jobs in a run from the external Execution Service.
     */
    public static Map<String, Object> getRunJobs(String runId) {
        return sendGet("/api/runs/" + runId + "/jobs");
    }

    /**
     * Cancel a run on the external Execution Service.
     */
    public static void cancelRun(String runId) {
        sendPost("/api/runs/" + runId + "/cancel", Map.of());
    }

    /**
     * Get a job report from the external Execution Service.
     */
    public static Map<String, Object> getJobReport(String runId, String jobId) {
        return sendGet("/api/runs/" + runId + "/jobs/" + jobId + "/report");
    }

    /**
     * Get the latest run for a given externalRef (cycleId) from the external Execution Service.
     * Returns the most recent run, or throws if none found.
     */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> getLatestRunByExternalRef(String externalRef) {
        Map<String, Object> response = sendGet("/api/runs?externalRef=" + externalRef);
        Object runsObj = response.get("runs");
        if (!(runsObj instanceof List<?> runsList) || runsList.isEmpty()) {
            throw new io.javalin.http.NotFoundResponse("No automated run found for this test run.");
        }
        return (Map<String, Object>) runsList.get(0);
    }

    /**
     * List API keys for a project on the external Execution Service.
     */
    public static Map<String, Object> listApiKeys(String projectId) {
        return sendGet("/api/apikeys?projectId=" + projectId);
    }

    /**
     * Create a new API key for a project on the external Execution Service.
     */
    public static Map<String, Object> createApiKey(String projectId, String name) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("projectId", projectId);
        payload.put("name", name);
        return sendPost("/api/apikeys", payload);
    }

    /**
     * Revoke an API key on the external Execution Service.
     */
    public static Map<String, Object> revokeApiKey(String keyId) {
        return sendDelete("/api/apikeys/" + keyId);
    }

    /**
     * Get queue stats from the external Execution Service.
     */
    public static Map<String, Object> getQueueStats() {
        return sendGet("/api/queue/stats");
    }

    /**
     * Get autoscaling recommendation from the external Execution Service.
     */
    public static Map<String, Object> getAutoscalingRecommendation() {
        return sendGet("/api/queue/autoscaling");
    }

    private static Map<String, Object> sendPost(String path, Object payload) {
        try {
            String json = mapper.writeValueAsString(payload);
            HttpRequest.Builder builder = HttpRequest.newBuilder()
                    .uri(URI.create(executionServiceBaseUrl() + path))
                    .timeout(Duration.ofSeconds(30))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8));
            addAuth(builder);
            HttpResponse<String> response = client.send(builder.build(),
                    HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new RuntimeException("Execution Service error (" + response.statusCode() + "): " + response.body());
            }
            if (response.body() == null || response.body().isBlank()) {
                return Map.of();
            }
            return mapper.readValue(response.body(), new TypeReference<>() {});
        } catch (Exception e) {
            throw new RuntimeException("Execution Service request failed: " + e.getMessage(), e);
        }
    }

    private static Map<String, Object> sendDelete(String path) {
        try {
            HttpRequest.Builder builder = HttpRequest.newBuilder()
                    .uri(URI.create(executionServiceBaseUrl() + path))
                    .timeout(Duration.ofSeconds(15))
                    .DELETE();
            addAuth(builder);
            HttpResponse<String> response = client.send(builder.build(),
                    HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new RuntimeException("Execution Service error (" + response.statusCode() + "): " + response.body());
            }
            if (response.body() == null || response.body().isBlank()) {
                return Map.of();
            }
            return mapper.readValue(response.body(), new TypeReference<>() {});
        } catch (Exception e) {
            throw new RuntimeException("Execution Service request failed: " + e.getMessage(), e);
        }
    }

    private static Map<String, Object> sendGet(String path) {
        try {
            HttpRequest.Builder builder = HttpRequest.newBuilder()
                    .uri(URI.create(executionServiceBaseUrl() + path))
                    .timeout(Duration.ofSeconds(15))
                    .GET();
            addAuth(builder);
            HttpResponse<String> response = client.send(builder.build(),
                    HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new RuntimeException("Execution Service error (" + response.statusCode() + "): " + response.body());
            }
            return mapper.readValue(response.body(), new TypeReference<>() {});
        } catch (Exception e) {
            throw new RuntimeException("Execution Service request failed: " + e.getMessage(), e);
        }
    }

    private static void addAuth(HttpRequest.Builder builder) {
        String apiKey = Config.EXECUTION_SERVICE_API_KEY;
        if (apiKey != null && !apiKey.isBlank()) {
            builder.header("x-agent-token", apiKey);
        }
    }

    private ExternalExecutionServiceClient() {}
}
