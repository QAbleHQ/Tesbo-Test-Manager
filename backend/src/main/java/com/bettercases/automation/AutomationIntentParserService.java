package com.bettercases.automation;

import com.bettercases.Config;
import com.bettercases.ai.AiHandler;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class AutomationIntentParserService {
    private static final ObjectMapper mapper = new ObjectMapper();
    private static final HttpClient client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(12))
            .build();

    private static final String OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
    private static final String ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
    private static final Set<String> OPENAI_MODELS = Set.of("gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini");
    private static final Set<String> ANTHROPIC_MODELS = Set.of("claude-sonnet-4-5-20250929", "claude-sonnet-4-5", "claude-3-7-sonnet-latest");

    private static final Pattern ABS_URL_PATTERN = Pattern.compile("https?://\\S+", Pattern.CASE_INSENSITIVE);
    private static final Pattern DOMAIN_PATTERN = Pattern.compile("\\b([a-zA-Z0-9-]+\\.)+[a-zA-Z]{2,}(/\\S*)?\\b");

    public static void ensureAiConfigured(UUID projectId) {
        Map<String, String> aiConfig = AiHandler.readAiConfig(projectId);
        String provider = normalizeProvider(aiConfig.getOrDefault("provider", "openai"));
        String apiKey = resolveApiKey(provider, aiConfig);
        if (apiKey.isBlank()) {
            throw new io.javalin.http.BadRequestResponse("Set AI API key in project settings to use Automation Generation.");
        }
    }

    public static AutomationContracts.ActionPlan plan(UUID projectId, String command, String currentUrl) {
        String raw = command == null ? "" : command.trim();
        if (raw.isBlank()) {
            throw new io.javalin.http.BadRequestResponse("command is required");
        }
        Map<String, String> aiConfig = AiHandler.readAiConfig(projectId);
        String provider = normalizeProvider(aiConfig.getOrDefault("provider", "openai"));
        String apiKey = resolveApiKey(provider, aiConfig);
        if (apiKey.isBlank()) {
            throw new io.javalin.http.BadRequestResponse("Set AI API key in project settings to use Automation Generation.");
        }
        String model = resolveModel(provider, aiConfig.getOrDefault("model", ""));

        try {
            AutomationContracts.ActionPlan aiPlan = interpretWithAi(provider, apiKey, model, raw, currentUrl);
            normalizePlan(aiPlan);
            if (aiPlan.requiresClarification || (aiPlan.steps != null && !aiPlan.steps.isEmpty())) {
                return aiPlan;
            }
        } catch (Exception ignored) {
            // fallback if provider is unavailable or parsing failed
        }
        return heuristicFallback(raw);
    }

    private static AutomationContracts.ActionPlan interpretWithAi(String provider, String apiKey, String model, String command, String currentUrl) throws Exception {
        String prompt = """
                You are an automation planner for browser actions.
                Convert the user command into JSON only.
                Supported actions: navigate, click, type.
                If needed info is missing, set requiresClarification=true and ask one clear question.
                If user says open/go to a domain like google.com, infer navigate URL with https://.
                Keep selectors practical (prefer role/text/testid style where possible).
                Output JSON schema exactly:
                {
                  "requiresClarification": boolean,
                  "clarificationQuestion": "string",
                  "steps": [
                    {
                      "id": "step-1",
                      "action": "navigate|click|type",
                      "url": "string|null",
                      "selector": "string|null",
                      "value": "string|null",
                      "timeoutMs": 10000
                    }
                  ]
                }
                Current URL: %s
                User command: %s
                """.formatted(currentUrl == null ? "" : currentUrl, command);

        String raw;
        if ("anthropic".equals(provider)) {
            raw = callAnthropic(apiKey, model, prompt);
        } else {
            raw = callOpenAi(apiKey, model, prompt);
        }
        return parsePlanFromJson(raw);
    }

    private static String callOpenAi(String apiKey, String model, String prompt) throws Exception {
        ObjectNode body = mapper.createObjectNode();
        body.put("model", model);
        body.put("temperature", 0.1);
        ArrayNode messages = body.putArray("messages");
        messages.addObject().put("role", "system").put("content", "Return JSON only.");
        messages.addObject().put("role", "user").put("content", prompt);

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(OPENAI_ENDPOINT))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + apiKey)
                .timeout(Duration.ofSeconds(35))
                .POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8))
                .build();
        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new RuntimeException("OpenAI HTTP " + response.statusCode() + ": " + response.body());
        }
        JsonNode root = mapper.readTree(response.body());
        return root.path("choices").path(0).path("message").path("content").asText("");
    }

    private static String callAnthropic(String apiKey, String model, String prompt) throws Exception {
        ObjectNode body = mapper.createObjectNode();
        body.put("model", model);
        body.put("max_tokens", 1500);
        body.put("temperature", 0.1);
        ArrayNode messages = body.putArray("messages");
        messages.addObject().put("role", "user").put("content", prompt);

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(ANTHROPIC_ENDPOINT))
                .header("Content-Type", "application/json")
                .header("x-api-key", apiKey)
                .header("anthropic-version", "2023-06-01")
                .timeout(Duration.ofSeconds(35))
                .POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8))
                .build();
        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new RuntimeException("Anthropic HTTP " + response.statusCode() + ": " + response.body());
        }
        JsonNode root = mapper.readTree(response.body());
        StringBuilder sb = new StringBuilder();
        for (JsonNode part : root.path("content")) {
            if ("text".equals(part.path("type").asText())) {
                sb.append(part.path("text").asText(""));
            }
        }
        return sb.toString();
    }

    private static AutomationContracts.ActionPlan parsePlanFromJson(String text) throws Exception {
        String cleaned = stripCodeFences(text);
        JsonNode node;
        try {
            node = mapper.readTree(cleaned);
        } catch (Exception e) {
            String obj = extractFirstJsonObject(cleaned);
            if (obj == null) throw e;
            node = mapper.readTree(obj);
        }
        AutomationContracts.ActionPlan plan = new AutomationContracts.ActionPlan();
        plan.commandId = UUID.randomUUID().toString();
        plan.requiresClarification = node.path("requiresClarification").asBoolean(false);
        plan.clarificationQuestion = node.path("clarificationQuestion").asText("");
        plan.steps = new ArrayList<>();
        JsonNode steps = node.path("steps");
        if (steps.isArray()) {
            for (int i = 0; i < steps.size(); i++) {
                JsonNode st = steps.get(i);
                AutomationContracts.ActionStep step = new AutomationContracts.ActionStep();
                step.id = st.path("id").asText("step-" + (i + 1));
                step.action = st.path("action").asText("");
                step.url = nullable(st.path("url").asText(""));
                step.selector = nullable(st.path("selector").asText(""));
                step.value = nullable(st.path("value").asText(""));
                step.timeoutMs = st.path("timeoutMs").asInt(Config.AUTOMATION_STEP_TIMEOUT_MS);
                plan.steps.add(step);
            }
        }
        return plan;
    }

    private static void normalizePlan(AutomationContracts.ActionPlan plan) {
        if (plan.commandId == null || plan.commandId.isBlank()) {
            plan.commandId = UUID.randomUUID().toString();
        }
        if (plan.steps == null) {
            plan.steps = new ArrayList<>();
        }
        for (int i = 0; i < plan.steps.size(); i++) {
            AutomationContracts.ActionStep step = plan.steps.get(i);
            if (step.id == null || step.id.isBlank()) step.id = "step-" + (i + 1);
            if (step.timeoutMs == null || step.timeoutMs <= 0) step.timeoutMs = Config.AUTOMATION_STEP_TIMEOUT_MS;
            if ("navigate".equals(step.action) && step.url != null && !step.url.startsWith("http://") && !step.url.startsWith("https://")) {
                step.url = "https://" + step.url;
            }
        }
    }

    private static AutomationContracts.ActionPlan heuristicFallback(String raw) {
        AutomationContracts.ActionPlan plan = new AutomationContracts.ActionPlan();
        plan.commandId = UUID.randomUUID().toString();
        plan.steps = new ArrayList<>();
        String lower = raw.toLowerCase(Locale.ROOT);

        Matcher abs = ABS_URL_PATTERN.matcher(raw);
        if (abs.find()) {
            AutomationContracts.ActionStep step = new AutomationContracts.ActionStep();
            step.id = "step-1";
            step.action = "navigate";
            step.url = abs.group();
            step.timeoutMs = Config.AUTOMATION_STEP_TIMEOUT_MS;
            plan.steps.add(step);
            return plan;
        }
        Matcher domain = DOMAIN_PATTERN.matcher(raw);
        if ((lower.contains("open") || lower.contains("navigate") || lower.contains("go to")) && domain.find()) {
            AutomationContracts.ActionStep step = new AutomationContracts.ActionStep();
            step.id = "step-1";
            step.action = "navigate";
            step.url = "https://" + domain.group();
            step.timeoutMs = Config.AUTOMATION_STEP_TIMEOUT_MS;
            plan.steps.add(step);
            return plan;
        }

        plan.requiresClarification = true;
        plan.clarificationQuestion = "Please clarify the action you want to perform in the browser.";
        return plan;
    }

    private static String resolveApiKey(String provider, Map<String, String> aiConfig) {
        if ("anthropic".equals(provider)) {
            return aiConfig.getOrDefault("anthropicApiKey", "").trim();
        }
        return aiConfig.getOrDefault("openAiApiKey", "").trim();
    }

    private static String resolveModel(String provider, String requested) {
        String candidate = requested == null ? "" : requested.trim();
        if ("anthropic".equals(provider)) {
            if (ANTHROPIC_MODELS.contains(candidate)) return candidate;
            return "claude-sonnet-4-5-20250929";
        }
        if (OPENAI_MODELS.contains(candidate)) return candidate;
        return "gpt-4o-mini";
    }

    private static String normalizeProvider(String provider) {
        if (provider == null || provider.isBlank()) return "openai";
        String normalized = provider.trim().toLowerCase(Locale.ROOT);
        if (!normalized.equals("openai") && !normalized.equals("anthropic")) {
            return "openai";
        }
        return normalized;
    }

    private static String stripCodeFences(String value) {
        String t = value == null ? "" : value.trim();
        if (!t.startsWith("```")) return t;
        int firstNewline = t.indexOf('\n');
        int lastFence = t.lastIndexOf("```");
        if (firstNewline > 0 && lastFence > firstNewline) {
            return t.substring(firstNewline + 1, lastFence).trim();
        }
        return t;
    }

    private static String extractFirstJsonObject(String text) {
        int start = text.indexOf('{');
        if (start < 0) return null;
        int depth = 0;
        boolean inString = false;
        boolean escape = false;
        for (int i = start; i < text.length(); i++) {
            char ch = text.charAt(i);
            if (escape) {
                escape = false;
                continue;
            }
            if (ch == '\\') {
                escape = true;
                continue;
            }
            if (ch == '"') {
                inString = !inString;
                continue;
            }
            if (inString) continue;
            if (ch == '{') depth++;
            if (ch == '}') {
                depth--;
                if (depth == 0) return text.substring(start, i + 1);
            }
        }
        return null;
    }

    private static String nullable(String value) {
        if (value == null) return null;
        String trimmed = value.trim();
        return trimmed.isEmpty() || "null".equalsIgnoreCase(trimmed) ? null : trimmed;
    }

    private AutomationIntentParserService() {}
}
