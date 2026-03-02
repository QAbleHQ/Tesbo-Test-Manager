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
import java.util.Collections;
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
    private static final Set<String> OPENAI_MODELS = Set.of("gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano");
    private static final Set<String> ANTHROPIC_MODELS = Set.of(
            "claude-sonnet-4-5-20250929",
            "claude-sonnet-4-5",
            "claude-sonnet-4-0",
            "claude-opus-4-6",
            "claude-3-7-sonnet-latest"
    );

    private static final Pattern ABS_URL_PATTERN = Pattern.compile("https?://\\S+", Pattern.CASE_INSENSITIVE);
    private static final Pattern DOMAIN_PATTERN = Pattern.compile("\\b([a-zA-Z0-9-]+\\.)+[a-zA-Z]{2,}(/\\S*)?\\b");

    public static void ensureAiConfigured(UUID projectId) {
        Map<String, String> aiConfig = AiHandler.readAiConfig(projectId);
        String provider = normalizeProvider(aiConfig.getOrDefault("provider", "openai"));
        String apiKey = resolveApiKey(provider, aiConfig);
        if (apiKey.isBlank()) {
            throw new io.javalin.http.BadRequestResponse("Set AI API key in project settings to use Autonomous mode commands.");
        }
    }

    public static AutomationContracts.ActionPlan plan(UUID projectId, String command, String currentUrl, String pageText) {
        String raw = command == null ? "" : command.trim();
        if (raw.isBlank()) {
            throw new io.javalin.http.BadRequestResponse("command is required");
        }
        Map<String, String> aiConfig = AiHandler.readAiConfig(projectId);
        String provider = normalizeProvider(aiConfig.getOrDefault("provider", "openai"));
        String apiKey = resolveApiKey(provider, aiConfig);
        if (apiKey.isBlank()) {
            throw new io.javalin.http.BadRequestResponse("Set AI API key in project settings to use Autonomous mode commands.");
        }
        String model = resolveModel(provider, aiConfig.getOrDefault("model", ""));

        try {
            AutomationContracts.ActionPlan aiPlan = interpretWithAi(provider, apiKey, model, raw, currentUrl, pageText);
            normalizePlan(aiPlan);
            if (aiPlan.requiresClarification || (aiPlan.steps != null && !aiPlan.steps.isEmpty())) {
                return aiPlan;
            }
        } catch (Exception ignored) {
            // fallback if provider is unavailable or parsing failed
        }
        return heuristicFallback(raw);
    }

    public static AutomationContracts.ActionPlan planAutonomousTurn(
            UUID projectId,
            String objective,
            String currentUrl,
            String pageText,
            List<String> executionHistory,
            int remainingStepBudget
    ) {
        String goal = objective == null ? "" : objective.trim();
        if (goal.isBlank()) {
            throw new io.javalin.http.BadRequestResponse("command is required");
        }
        Map<String, String> aiConfig = AiHandler.readAiConfig(projectId);
        String provider = normalizeProvider(aiConfig.getOrDefault("provider", "openai"));
        String apiKey = resolveApiKey(provider, aiConfig);
        if (apiKey.isBlank()) {
            throw new io.javalin.http.BadRequestResponse("Set AI API key in project settings to use Autonomous mode commands.");
        }
        String model = resolveModel(provider, aiConfig.getOrDefault("model", ""));
        List<String> history = executionHistory == null ? Collections.emptyList() : executionHistory;
        int safeBudget = Math.max(0, remainingStepBudget);

        try {
            AutomationContracts.ActionPlan aiPlan = interpretAutonomousTurnWithAi(
                    provider,
                    apiKey,
                    model,
                    goal,
                    currentUrl,
                    pageText,
                    history,
                    safeBudget
            );
            normalizePlan(aiPlan);
            if (aiPlan.requiresClarification || aiPlan.goalAchieved || (aiPlan.steps != null && !aiPlan.steps.isEmpty())) {
                return aiPlan;
            }
        } catch (Exception ignored) {
            // fallback if provider is unavailable or parsing failed
        }
        return heuristicFallback(goal);
    }

    public static AutomationContracts.ActionPlan planAutonomousBootstrapTurn(
            UUID projectId,
            String objective,
            String currentUrl,
            String pageText,
            List<String> executionHistory,
            int remainingStepBudget
    ) {
        String goal = objective == null ? "" : objective.trim();
        if (goal.isBlank()) {
            throw new io.javalin.http.BadRequestResponse("command is required");
        }
        Map<String, String> aiConfig = AiHandler.readAiConfig(projectId);
        String provider = normalizeProvider(aiConfig.getOrDefault("provider", "openai"));
        String apiKey = resolveApiKey(provider, aiConfig);
        if (apiKey.isBlank()) {
            throw new io.javalin.http.BadRequestResponse("Set AI API key in project settings to use Autonomous mode commands.");
        }
        String model = resolveModel(provider, aiConfig.getOrDefault("model", ""));
        List<String> history = executionHistory == null ? Collections.emptyList() : executionHistory;
        int safeBudget = Math.max(0, remainingStepBudget);

        try {
            AutomationContracts.ActionPlan aiPlan = interpretAutonomousBootstrapWithAi(
                    provider,
                    apiKey,
                    model,
                    goal,
                    currentUrl,
                    pageText,
                    history,
                    safeBudget
            );
            normalizePlan(aiPlan);
            return aiPlan;
        } catch (Exception ignored) {
            // fallback if provider is unavailable or parsing failed
        }
        return heuristicBootstrap(goal, pageText);
    }

    private static AutomationContracts.ActionPlan interpretWithAi(String provider, String apiKey, String model, String command, String currentUrl, String pageText) throws Exception {
        String prompt = """
                You are an AI-driven autonomous browser planner.
                Understand current page context first, then infer user intent, then decide the minimum reliable number of steps.
                Convert the user command into JSON only.
                Supported actions: navigate, click, type, assert_visible, assert_text, assert_clickable.
                Prioritize user-requested actions over generic safety checks.
                Do NOT add extra verification/assertion steps unless:
                - the user explicitly asks to verify/assert/check, OR
                - one focused assertion is required to confirm objective completion.
                Avoid pre-checking every step; keep plans lean and action-first.
                If needed info is missing, set requiresClarification=true and ask one clear question.
                If user says open/go to a domain like google.com, infer navigate URL with https://.
                Keep selectors practical (prefer role/text/testid style where possible).
                When similar elements may exist, make targetDescription uniquely identifying
                (include nearby heading/section/dialog/form context and control type).
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
                      "targetDescription": "string|null",
                      "value": "string|null",
                      "expectedText": "string|null",
                      "timeoutMs": 10000
                    }
                  ]
                }
                Current URL: %s
                Visible page text snippet: %s
                User command: %s
                """.formatted(
                currentUrl == null ? "" : currentUrl,
                pageText == null ? "" : pageText.substring(0, Math.min(pageText.length(), 2000)),
                command
        );

        String raw;
        if ("anthropic".equals(provider)) {
            raw = callAnthropic(apiKey, model, prompt);
        } else {
            raw = callOpenAi(apiKey, model, prompt);
        }
        return parsePlanFromJson(raw);
    }

    private static AutomationContracts.ActionPlan interpretAutonomousTurnWithAi(
            String provider,
            String apiKey,
            String model,
            String objective,
            String currentUrl,
            String pageText,
            List<String> executionHistory,
            int remainingStepBudget
    ) throws Exception {
        String historySnippet = buildHistorySnippet(executionHistory);
        String prompt = """
                You are an autonomous browser agent running in a think-act-observe loop.
                Decide ONLY the next best actions for this turn.

                Rules:
                1) First infer whether the objective is already achieved from current page context.
                2) If achieved, return goalAchieved=true with no steps.
                3) If not achieved, return a short actionable step list for this turn only.
                4) Prefer robust selectors and disambiguated targetDescription.
                5) Keep this turn within the remaining step budget.
                6) If previous turn failed, try an alternative strategy in this turn.
                7) Do not return assertion-only steps when no meaningful user action has been executed yet.
                8) Do not add generic validation that user did not request. Assertions are allowed only when
                   explicitly requested or when needed to confirm final objective completion.
                9) If target text is likely ambiguous, include context in targetDescription
                   (for example: "Save button in Profile section", "Email field in Login form").
                10) Return valid JSON only.

                Supported actions: navigate, click, type, assert_visible, assert_text, assert_clickable.
                If exact CSS selector is uncertain, prefer selector=null and provide targetDescription
                (for example button/link/field label text) so runtime can resolve robustly.

                Output JSON schema exactly:
                {
                  "requiresClarification": boolean,
                  "clarificationQuestion": "string",
                  "goalAchieved": boolean,
                  "completionReason": "string",
                  "steps": [
                    {
                      "id": "step-1",
                      "action": "navigate|click|type|assert_visible|assert_text|assert_clickable",
                      "url": "string|null",
                      "selector": "string|null",
                      "targetDescription": "string|null",
                      "value": "string|null",
                      "expectedText": "string|null",
                      "timeoutMs": 10000
                    }
                  ]
                }

                Objective: %s
                Remaining step budget: %s
                Current URL: %s
                Visible page text snippet: %s
                Execution history (oldest to newest):
                %s
                """.formatted(
                objective,
                remainingStepBudget,
                currentUrl == null ? "" : currentUrl,
                pageText == null ? "" : pageText.substring(0, Math.min(pageText.length(), 2200)),
                historySnippet
        );

        String raw;
        if ("anthropic".equals(provider)) {
            raw = callAnthropic(apiKey, model, prompt);
        } else {
            raw = callOpenAi(apiKey, model, prompt);
        }
        return parsePlanFromJson(raw);
    }

    private static AutomationContracts.ActionPlan interpretAutonomousBootstrapWithAi(
            String provider,
            String apiKey,
            String model,
            String objective,
            String currentUrl,
            String pageText,
            List<String> executionHistory,
            int remainingStepBudget
    ) throws Exception {
        String historySnippet = buildHistorySnippet(executionHistory);
        String prompt = """
                You are an autonomous browser agent bootstrap planner.
                Previous turns were non-actionable. You MUST return an actionable starter turn.

                Hard requirements:
                1) Return 1-4 steps only.
                2) Include at least one non-assert action: navigate, click, or type.
                3) Do NOT return assertion-only steps.
                4) Prefer targetDescription when selector is uncertain.
                5) Keep to the remaining step budget.
                6) Keep steps action-first and avoid unrequested generic checks.
                7) If UI likely has similar elements, make targetDescription uniquely identifying with context.
                8) Return valid JSON only.

                Supported actions: navigate, click, type, assert_visible, assert_text, assert_clickable.

                Output JSON schema exactly:
                {
                  "requiresClarification": boolean,
                  "clarificationQuestion": "string",
                  "goalAchieved": boolean,
                  "completionReason": "string",
                  "steps": [
                    {
                      "id": "step-1",
                      "action": "navigate|click|type|assert_visible|assert_text|assert_clickable",
                      "url": "string|null",
                      "selector": "string|null",
                      "targetDescription": "string|null",
                      "value": "string|null",
                      "expectedText": "string|null",
                      "timeoutMs": 10000
                    }
                  ]
                }

                Objective: %s
                Remaining step budget: %s
                Current URL: %s
                Visible page text snippet: %s
                Execution history (oldest to newest):
                %s
                """.formatted(
                objective,
                remainingStepBudget,
                currentUrl == null ? "" : currentUrl,
                pageText == null ? "" : pageText.substring(0, Math.min(pageText.length(), 2200)),
                historySnippet
        );

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
        plan.goalAchieved = node.path("goalAchieved").asBoolean(false);
        plan.completionReason = node.path("completionReason").asText("");
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
                step.targetDescription = nullable(st.path("targetDescription").asText(""));
                step.value = nullable(st.path("value").asText(""));
                step.expectedText = nullable(st.path("expectedText").asText(""));
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
            if ((step.selector == null || step.selector.isBlank()) &&
                    step.targetDescription != null &&
                    !step.targetDescription.isBlank() &&
                    ("assert_visible".equals(step.action) || "assert_clickable".equals(step.action))) {
                step.expectedText = step.targetDescription;
            }
        }
    }

    private static AutomationContracts.ActionPlan heuristicFallback(String raw) {
        AutomationContracts.ActionPlan plan = new AutomationContracts.ActionPlan();
        plan.commandId = UUID.randomUUID().toString();
        plan.steps = new ArrayList<>();
        plan.goalAchieved = false;
        plan.completionReason = "";
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

        if (lower.contains("verify") || lower.contains("assert") || lower.contains("displayed") || lower.contains("visible")) {
            String target = extractAfterKeywords(raw, List.of("verify that", "verify", "assert that", "assert", "displayed", "visible"));
            AutomationContracts.ActionStep step = new AutomationContracts.ActionStep();
            step.id = "step-1";
            step.action = "assert_visible";
            step.selector = target != null ? "text=" + target : null;
            step.expectedText = target;
            step.timeoutMs = Config.AUTOMATION_STEP_TIMEOUT_MS;
            plan.steps.add(step);
            return plan;
        }

        if (lower.contains("compare text") || lower.contains("text should be") || lower.contains("equals text")) {
            String target = extractAfterKeywords(raw, List.of("compare text", "text should be", "equals text"));
            AutomationContracts.ActionStep step = new AutomationContracts.ActionStep();
            step.id = "step-1";
            step.action = "assert_text";
            step.expectedText = target;
            step.selector = null;
            step.timeoutMs = Config.AUTOMATION_STEP_TIMEOUT_MS;
            plan.steps.add(step);
            return plan;
        }

        if (lower.contains("clickable") || lower.contains("can click") || lower.contains("enabled")) {
            String target = extractAfterKeywords(raw, List.of("clickable", "can click", "enabled"));
            AutomationContracts.ActionStep step = new AutomationContracts.ActionStep();
            step.id = "step-1";
            step.action = "assert_clickable";
            step.selector = target != null ? "text=" + target : "button";
            step.timeoutMs = Config.AUTOMATION_STEP_TIMEOUT_MS;
            plan.steps.add(step);
            return plan;
        }

        if (lower.contains("click")) {
            String target = extractAfterKeywords(raw, List.of("click on", "click"));
            AutomationContracts.ActionStep step = new AutomationContracts.ActionStep();
            step.id = "step-1";
            step.action = "click";
            step.selector = target != null ? "text=" + target : "button";
            step.timeoutMs = Config.AUTOMATION_STEP_TIMEOUT_MS;
            plan.steps.add(step);
            return plan;
        }

        plan.requiresClarification = true;
        plan.clarificationQuestion = "Please clarify the action you want to perform in the browser.";
        return plan;
    }

    private static AutomationContracts.ActionPlan heuristicBootstrap(String objective, String pageText) {
        AutomationContracts.ActionPlan plan = new AutomationContracts.ActionPlan();
        plan.commandId = UUID.randomUUID().toString();
        plan.goalAchieved = false;
        plan.completionReason = "";
        plan.requiresClarification = false;
        plan.steps = new ArrayList<>();

        String text = (pageText == null ? "" : pageText).toLowerCase(Locale.ROOT);
        String goal = (objective == null ? "" : objective).toLowerCase(Locale.ROOT);

        if (goal.contains("form") && (text.contains("name") || text.contains("email"))) {
            AutomationContracts.ActionStep step = new AutomationContracts.ActionStep();
            step.id = "step-1";
            step.action = "type";
            step.targetDescription = text.contains("name") ? "Name" : "Email";
            step.value = "Test User";
            step.timeoutMs = Config.AUTOMATION_STEP_TIMEOUT_MS;
            plan.steps.add(step);
            return plan;
        }

        AutomationContracts.ActionStep step = new AutomationContracts.ActionStep();
        step.id = "step-1";
        step.action = "click";
        step.targetDescription = "Submit";
        step.timeoutMs = Config.AUTOMATION_STEP_TIMEOUT_MS;
        plan.steps.add(step);
        return plan;
    }

    private static String buildHistorySnippet(List<String> executionHistory) {
        if (executionHistory == null || executionHistory.isEmpty()) return "(none)";
        int start = Math.max(0, executionHistory.size() - 20);
        StringBuilder sb = new StringBuilder();
        for (int i = start; i < executionHistory.size(); i++) {
            String row = executionHistory.get(i);
            if (row == null || row.isBlank()) continue;
            sb.append("- ").append(row).append("\n");
        }
        String out = sb.toString().trim();
        if (out.isBlank()) return "(none)";
        return out.length() > 3000 ? out.substring(out.length() - 3000) : out;
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

    private static String extractAfterKeywords(String raw, List<String> keywords) {
        String lower = raw.toLowerCase(Locale.ROOT);
        for (String key : keywords) {
            int idx = lower.indexOf(key);
            if (idx >= 0) {
                String out = raw.substring(idx + key.length()).trim();
                out = out.replaceAll("^[:\\-\\s]+", "").trim();
                out = out.replaceAll("^[\"']|[\"']$", "").trim();
                if (!out.isBlank()) return out;
            }
        }
        return null;
    }

    private AutomationIntentParserService() {}
}
