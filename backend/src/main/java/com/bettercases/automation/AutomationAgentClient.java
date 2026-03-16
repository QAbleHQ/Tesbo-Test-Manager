package com.bettercases.automation;

import com.bettercases.Config;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

public final class AutomationAgentClient {
    private static final ObjectMapper mapper = new ObjectMapper();
    static {
        mapper.configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
    }
    private static final HttpClient client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();

    public static Map<String, Object> createSession(
            UUID sessionId,
            String startUrl,
            UUID projectId,
            UUID testcaseId,
            String browserbaseApiKey,
            String browserbaseProjectId,
            String modelProvider,
            String modelApiKey,
            String model
    ) {
        Map<String, Object> payload = new HashMap<>();
        payload.put("sessionId", sessionId.toString());
        payload.put("startUrl", startUrl == null ? "" : startUrl);
        if (projectId != null) payload.put("projectId", projectId.toString());
        if (testcaseId != null) payload.put("testcaseId", testcaseId.toString());
        if (browserbaseApiKey != null && !browserbaseApiKey.isBlank()) payload.put("browserbaseApiKey", browserbaseApiKey);
        if (browserbaseProjectId != null && !browserbaseProjectId.isBlank()) payload.put("browserbaseProjectId", browserbaseProjectId);
        if (modelProvider != null && !modelProvider.isBlank()) payload.put("modelProvider", modelProvider);
        if (modelApiKey != null && !modelApiKey.isBlank()) payload.put("modelApiKey", modelApiKey);
        if (model != null && !model.isBlank()) payload.put("model", model);
        String body = send("/internal/sessions", "POST", payload);
        try {
            return mapper.readValue(body, new com.fasterxml.jackson.core.type.TypeReference<>() {});
        } catch (Exception e) {
            throw new RuntimeException("Failed to parse automation agent create session response", e);
        }
    }

    public static AutomationContracts.AgentExecuteResponse executeSteps(UUID sessionId, String commandId, java.util.List<AutomationContracts.ActionStep> steps) {
        String body = send("/internal/sessions/" + sessionId + "/execute", "POST", Map.of(
                "commandId", commandId,
                "steps", steps
        ), Duration.ofSeconds(180));
        try {
            return mapper.readValue(body, AutomationContracts.AgentExecuteResponse.class);
        } catch (Exception e) {
            throw new RuntimeException("Failed to parse automation agent execute response", e);
        }
    }

    public static AutomationContracts.AgentExecuteResponse executeStagehand(UUID sessionId, String commandId, String objective) {
        String body = send("/internal/sessions/" + sessionId + "/execute-stagehand", "POST", Map.of(
                "commandId", commandId,
                "objective", objective == null ? "" : objective
        ), Duration.ofSeconds(240));
        try {
            return mapper.readValue(body, AutomationContracts.AgentExecuteResponse.class);
        } catch (Exception e) {
            throw new RuntimeException("Failed to parse stagehand execute response", e);
        }
    }

    public static Map<String, Object> getSessionState(UUID sessionId) {
        String body = send("/internal/sessions/" + sessionId + "/state", "GET", null);
        try {
            return mapper.readValue(body, new com.fasterxml.jackson.core.type.TypeReference<>() {});
        } catch (Exception e) {
            throw new RuntimeException("Failed to parse automation agent session state", e);
        }
    }

    public static Map<String, Object> resetSession(UUID sessionId, String startUrl) {
        String body = send("/internal/sessions/" + sessionId + "/reset", "POST", Map.of(
                "startUrl", startUrl == null ? "" : startUrl
        ), Duration.ofSeconds(120));
        try {
            return mapper.readValue(body, new com.fasterxml.jackson.core.type.TypeReference<>() {});
        } catch (Exception e) {
            throw new RuntimeException("Failed to parse automation agent reset response", e);
        }
    }

    public static Map<String, Object> closeSession(UUID sessionId) {
        String body = send("/internal/sessions/" + sessionId + "/close", "POST", Map.of());
        try {
            return mapper.readValue(body, new com.fasterxml.jackson.core.type.TypeReference<>() {});
        } catch (Exception e) {
            return Map.of("videoPath", null);
        }
    }

    public static Map<String, Object> manualAction(UUID sessionId, Map<String, Object> action) {
        String body = send("/internal/sessions/" + sessionId + "/manual-action", "POST", action == null ? Map.of() : action);
        try {
            return mapper.readValue(body, new com.fasterxml.jackson.core.type.TypeReference<>() {});
        } catch (Exception e) {
            throw new RuntimeException("Failed to parse automation agent manual action response", e);
        }
    }

    public static Map<String, Object> runPlaywrightScript(
            UUID executionId,
            String script,
            String startUrl,
            String modelProvider,
            String modelApiKey,
            String model,
            String browserbaseApiKey,
            String browserbaseProjectId,
            String cacheScope
    ) {
        Map<String, Object> payload = new HashMap<>();
        payload.put("executionId", executionId.toString());
        payload.put("script", script == null ? "" : script);
        payload.put("startUrl", startUrl == null ? "" : startUrl);
        if (modelProvider != null && !modelProvider.isBlank()) payload.put("modelProvider", modelProvider);
        if (modelApiKey != null && !modelApiKey.isBlank()) payload.put("modelApiKey", modelApiKey);
        if (model != null && !model.isBlank()) payload.put("model", model);
        if (browserbaseApiKey != null && !browserbaseApiKey.isBlank()) payload.put("browserbaseApiKey", browserbaseApiKey);
        if (browserbaseProjectId != null && !browserbaseProjectId.isBlank()) payload.put("browserbaseProjectId", browserbaseProjectId);
        if (cacheScope != null && !cacheScope.isBlank()) payload.put("cacheScope", cacheScope);
        String body = send("/internal/playwright/run", "POST", payload, Duration.ofSeconds(180));
        try {
            return mapper.readValue(body, new com.fasterxml.jackson.core.type.TypeReference<>() {});
        } catch (Exception e) {
            throw new RuntimeException("Failed to parse automation agent playwright run response", e);
        }
    }

    public static Map<String, Object> runPlaywrightScriptInSession(UUID sessionId, UUID executionId, String script, String startUrl, Integer actionDelayMs) {
        String body = send("/internal/sessions/" + sessionId + "/run-script", "POST", Map.of(
                "executionId", executionId.toString(),
                "script", script == null ? "" : script,
                "startUrl", startUrl == null ? "" : startUrl,
                "actionDelayMs", actionDelayMs == null ? 0 : Math.max(0, actionDelayMs)
        ), Duration.ofSeconds(300));
        try {
            return mapper.readValue(body, new com.fasterxml.jackson.core.type.TypeReference<>() {});
        } catch (Exception e) {
            throw new RuntimeException("Failed to parse automation agent in-session script run response", e);
        }
    }

    public static Map<String, Object> getRecording(UUID sessionId) {
        String body = send("/internal/sessions/" + sessionId + "/recording", "GET", null);
        try {
            return mapper.readValue(body, new com.fasterxml.jackson.core.type.TypeReference<>() {});
        } catch (Exception e) {
            throw new RuntimeException("Failed to parse automation agent recording response", e);
        }
    }

    public static Map<String, Object> compileRecording(UUID sessionId, Map<String, Object> options) {
        String body = send("/internal/sessions/" + sessionId + "/recording/compile", "POST", options == null ? Map.of() : options);
        try {
            return mapper.readValue(body, new com.fasterxml.jackson.core.type.TypeReference<>() {});
        } catch (Exception e) {
            throw new RuntimeException("Failed to parse automation agent recording compile response", e);
        }
    }

    public static Map<String, Object> enqueueAutomationJob(Map<String, Object> payload) {
        String body = sendQueue("/internal/queue/jobs", "POST", payload);
        try {
            return mapper.readValue(body, new com.fasterxml.jackson.core.type.TypeReference<>() {});
        } catch (Exception e) {
            throw new RuntimeException("Failed to parse automation queue enqueue response", e);
        }
    }

    public static void cancelRunQueue(UUID runId) {
        sendQueue("/internal/queue/runs/" + runId + "/cancel", "POST", Map.of());
    }

    public static Map<String, Object> queueStats() {
        String body = sendQueue("/internal/queue/stats", "GET", null, Duration.ofSeconds(5));
        try {
            return mapper.readValue(body, new com.fasterxml.jackson.core.type.TypeReference<>() {});
        } catch (Exception e) {
            throw new RuntimeException("Failed to parse automation queue stats", e);
        }
    }

    private static String send(String path, String method, Object payload) {
        return send(path, method, payload, Duration.ofSeconds(40));
    }

    private static String send(String path, String method, Object payload, Duration timeout) {
        return send(Config.AUTOMATION_AGENT_BASE_URL, path, method, payload, timeout);
    }

    private static String sendQueue(String path, String method, Object payload) {
        return sendQueue(path, method, payload, Duration.ofSeconds(40));
    }

    private static String sendQueue(String path, String method, Object payload, Duration timeout) {
        return send(Config.AUTOMATION_QUEUE_API_BASE_URL, path, method, payload, timeout);
    }

    private static String send(String baseUrl, String path, String method, Object payload, Duration timeout) {
        try {
            HttpRequest.Builder builder = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + path))
                    .timeout(timeout == null ? Duration.ofSeconds(40) : timeout)
                    .header("Content-Type", "application/json");
            if (!Config.AUTOMATION_AGENT_SHARED_TOKEN.isBlank()) {
                builder.header("x-agent-token", Config.AUTOMATION_AGENT_SHARED_TOKEN);
            }
            if ("GET".equals(method)) {
                builder.GET();
            } else {
                String json = payload == null ? "{}" : mapper.writeValueAsString(payload);
                builder.method(method, HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8));
            }
            HttpResponse<String> response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new RuntimeException("Automation agent error (" + response.statusCode() + "): " + response.body());
            }
            return response.body();
        } catch (Exception e) {
            throw new RuntimeException("Automation agent request failed: " + e.getMessage(), e);
        }
    }

    private AutomationAgentClient() {}
}
