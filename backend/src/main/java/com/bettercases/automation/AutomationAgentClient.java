package com.bettercases.automation;

import com.bettercases.Config;
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
        ));
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

    public static void closeSession(UUID sessionId) {
        send("/internal/sessions/" + sessionId + "/close", "POST", Map.of());
    }

    private static String send(String path, String method, Object payload) {
        try {
            HttpRequest.Builder builder = HttpRequest.newBuilder()
                    .uri(URI.create(Config.AUTOMATION_AGENT_BASE_URL + path))
                    .timeout(Duration.ofSeconds(40))
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
