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

    public static void createSession(UUID sessionId, String startUrl) {
        send("/internal/sessions", "POST", Map.of(
                "sessionId", sessionId.toString(),
                "startUrl", startUrl == null ? "" : startUrl
        ));
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

    public static Map<String, Object> runPlaywrightScript(UUID executionId, String script, String startUrl) {
        String body = send("/internal/playwright/run", "POST", Map.of(
                "executionId", executionId.toString(),
                "script", script == null ? "" : script,
                "startUrl", startUrl == null ? "" : startUrl
        ), Duration.ofSeconds(180));
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

    public static Map<String, Object> enqueueAutomationJob(Map<String, Object> payload) {
        String body = send("/internal/queue/jobs", "POST", payload);
        try {
            return mapper.readValue(body, new com.fasterxml.jackson.core.type.TypeReference<>() {});
        } catch (Exception e) {
            throw new RuntimeException("Failed to parse automation queue enqueue response", e);
        }
    }

    public static void cancelRunQueue(UUID runId) {
        send("/internal/queue/runs/" + runId + "/cancel", "POST", Map.of());
    }

    public static Map<String, Object> queueStats() {
        String body = send("/internal/queue/stats", "GET", null, Duration.ofSeconds(5));
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
        try {
            HttpRequest.Builder builder = HttpRequest.newBuilder()
                    .uri(URI.create(Config.AUTOMATION_AGENT_BASE_URL + path))
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
