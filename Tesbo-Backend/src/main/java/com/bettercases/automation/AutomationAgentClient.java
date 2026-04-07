package com.bettercases.automation;

import com.bettercases.Config;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.ConnectException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
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
    public static final class AgentUnavailableException extends RuntimeException {
        public final String code;
        public final int upstreamStatus;
        public final boolean retryable;

        public AgentUnavailableException(String code, String message, int upstreamStatus, boolean retryable, Throwable cause) {
            super(message, cause);
            this.code = code;
            this.upstreamStatus = upstreamStatus;
            this.retryable = retryable;
        }
    }

    public static Map<String, Object> createSession(
            UUID sessionId,
            String startUrl,
            UUID projectId,
            UUID testcaseId,
            String modelProvider,
            String modelApiKey,
            String model
    ) {
        Map<String, Object> payload = new HashMap<>();
        payload.put("sessionId", sessionId.toString());
        payload.put("startUrl", startUrl == null ? "" : startUrl);
        if (projectId != null) payload.put("projectId", projectId.toString());
        if (testcaseId != null) payload.put("testcaseId", testcaseId.toString());
        if (modelProvider != null && !modelProvider.isBlank()) payload.put("modelProvider", modelProvider);
        if (modelApiKey != null && !modelApiKey.isBlank()) payload.put("modelApiKey", modelApiKey);
        if (model != null && !model.isBlank()) payload.put("model", model);
        String body = sendWithRetry("/internal/sessions", "POST", payload, Duration.ofSeconds(40), sessionId.toString(), 2);
        try {
            return mapper.readValue(body, new com.fasterxml.jackson.core.type.TypeReference<>() {});
        } catch (Exception e) {
            throw new RuntimeException("Failed to parse automation agent create session response", e);
        }
    }

    public static AutomationContracts.AgentExecuteResponse executeSteps(UUID sessionId, String commandId, java.util.List<AutomationContracts.ActionStep> steps) {
        String body = sendWithRetry("/internal/sessions/" + sessionId + "/execute", "POST", Map.of(
                "commandId", commandId,
                "steps", steps
        ), Duration.ofSeconds(180), commandId, 1);
        try {
            return mapper.readValue(body, AutomationContracts.AgentExecuteResponse.class);
        } catch (Exception e) {
            throw new RuntimeException("Failed to parse automation agent execute response", e);
        }
    }

    public static AutomationContracts.AgentExecuteResponse executeAgent(UUID sessionId, String commandId, String objective) {
        String body = sendWithRetry("/internal/sessions/" + sessionId + "/execute-agent", "POST", Map.of(
                "commandId", commandId,
                "objective", objective == null ? "" : objective
        ), Duration.ofSeconds(240), commandId, 1);
        try {
            return mapper.readValue(body, AutomationContracts.AgentExecuteResponse.class);
        } catch (Exception e) {
            throw new RuntimeException("Failed to parse agent execute response", e);
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
            String cacheScope
    ) {
        Map<String, Object> payload = new HashMap<>();
        payload.put("executionId", executionId.toString());
        payload.put("script", script == null ? "" : script);
        payload.put("startUrl", startUrl == null ? "" : startUrl);
        if (modelProvider != null && !modelProvider.isBlank()) payload.put("modelProvider", modelProvider);
        if (modelApiKey != null && !modelApiKey.isBlank()) payload.put("modelApiKey", modelApiKey);
        if (model != null && !model.isBlank()) payload.put("model", model);
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

    private static String send(String path, String method, Object payload) {
        return send(path, method, payload, Duration.ofSeconds(40));
    }

    private static String send(String path, String method, Object payload, Duration timeout) {
        return send(Config.AUTOMATION_AGENT_BASE_URL, path, method, payload, timeout, null);
    }

    private static String sendWithRetry(String path, String method, Object payload, Duration timeout, String idempotencyKey, int maxRetries) {
        int attempts = 0;
        AgentUnavailableException last = null;
        while (attempts <= Math.max(0, maxRetries)) {
            attempts += 1;
            try {
                return send(Config.AUTOMATION_AGENT_BASE_URL, path, method, payload, timeout, idempotencyKey);
            } catch (AgentUnavailableException e) {
                last = e;
                if (!e.retryable || attempts > Math.max(0, maxRetries)) throw e;
                try {
                    Thread.sleep(200L * attempts);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    throw e;
                }
            }
        }
        if (last != null) throw last;
        throw new AgentUnavailableException("upstream_unavailable", "Automation agent request failed", 0, true, null);
    }

    private static String send(String baseUrl, String path, String method, Object payload, Duration timeout, String idempotencyKey) {
        try {
            HttpRequest.Builder builder = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + path))
                    .timeout(timeout == null ? Duration.ofSeconds(40) : timeout)
                    .header("Content-Type", "application/json");
            if (!Config.AUTOMATION_AGENT_SHARED_TOKEN.isBlank()) {
                builder.header("x-agent-token", Config.AUTOMATION_AGENT_SHARED_TOKEN);
            }
            if (idempotencyKey != null && !idempotencyKey.isBlank()) {
                builder.header("x-idempotency-key", idempotencyKey);
            }
            if ("GET".equals(method)) {
                builder.GET();
            } else {
                String json = payload == null ? "{}" : mapper.writeValueAsString(payload);
                builder.method(method, HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8));
            }
            HttpResponse<String> response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw classifyStatus(response.statusCode(), response.body(), null);
            }
            return response.body();
        } catch (Exception e) {
            if (e instanceof AgentUnavailableException aue) throw aue;
            if (e instanceof HttpTimeoutException || e instanceof ConnectException) {
                throw new AgentUnavailableException("upstream_unavailable",
                        "Automation agent request failed: " + e.getMessage(), 0, true, e);
            }
            String message = e.getMessage() == null ? "Automation agent request failed" : e.getMessage();
            throw new AgentUnavailableException("upstream_unavailable", "Automation agent request failed: " + message, 0, true, e);
        }
    }

    private static AgentUnavailableException classifyStatus(int statusCode, String body, Throwable cause) {
        String safeBody = body == null ? "" : body;
        String code;
        boolean retryable;
        if (statusCode == 429) {
            code = "busy";
            retryable = true;
        } else if (statusCode == 409) {
            code = "lock_conflict";
            retryable = true;
        } else if (statusCode == 425 || statusCode == 423 || statusCode == 404) {
            code = "session_not_ready";
            retryable = true;
        } else if (statusCode == 503 || statusCode == 502 || statusCode == 504) {
            code = "upstream_unavailable";
            retryable = true;
        } else {
            code = "upstream_unavailable";
            retryable = false;
        }
        return new AgentUnavailableException(
                code,
                "Automation agent error (" + statusCode + "): " + safeBody,
                statusCode,
                retryable,
                cause
        );
    }

    private AutomationAgentClient() {}
}
