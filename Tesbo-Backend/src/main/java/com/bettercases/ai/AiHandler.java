package com.bettercases.ai;

import com.bettercases.Database;
import com.bettercases.audit.AuditService;
import com.bettercases.auth.SessionFilter;
import com.bettercases.rbac.RbacService;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.javalin.http.Context;

import java.util.ArrayList;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

public final class AiHandler {
    private static final ObjectMapper mapper = new ObjectMapper();
    private static final Set<String> OPENAI_MODEL_OPTIONS = new LinkedHashSet<>(List.of(
            "gpt-4o",
            "gpt-4o-mini",
            "gpt-4.1",
            "gpt-4.1-mini",
            "gpt-4.1-nano"
    ));
    private static final Set<String> ANTHROPIC_MODEL_OPTIONS = new LinkedHashSet<>(List.of(
            "claude-sonnet-4-5-20250929",
            "claude-sonnet-4-5",
            "claude-sonnet-4-0",
            "claude-opus-4-6",
            "claude-3-7-sonnet-latest"
    ));

    public static void generateTestCases(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canEditCases())
            throw new io.javalin.http.ForbiddenResponse("Cannot use AI");
        GenerateBody body = ctx.bodyAsClass(GenerateBody.class);
        if (body == null || body.userStory == null || body.userStory.isBlank()) {
            ctx.status(400).json(Map.of("error", "userStory required"));
            return;
        }
        long startedAt = System.currentTimeMillis();
        Map<String, String> aiConfig = readAiConfig(projectId);
        // Provider/model are controlled by the allocated workspace AI key.
        String selectedProvider = normalizeProvider(aiConfig.getOrDefault("provider", "openai"));
        String apiKey = resolveProviderApiKey(selectedProvider, aiConfig);
        String model = resolveModel(selectedProvider, null, aiConfig);

        int requestedCount = body.count != null && body.count > 0 ? Math.min(body.count, 20) : 5;
        boolean includeHappyFlow = body.includeHappyFlow == null || body.includeHappyFlow;
        boolean includeNegativeFlow = body.includeNegativeFlow == null || body.includeNegativeFlow;
        boolean includeMultiTab = body.includeMultiTab != null && body.includeMultiTab;
        boolean includeCrossBrowser = body.includeCrossBrowser != null && body.includeCrossBrowser;
        boolean includeBoundary = body.includeBoundary == null || body.includeBoundary;

        AiLoggers.generationInfo(
                "generation_request_received projectId=" + projectId +
                        " userId=" + userId +
                        " provider=" + selectedProvider +
                        " model=" + (model == null || model.isBlank() ? "default" : model) +
                        " requestedCount=" + requestedCount +
                        " includeHappy=" + includeHappyFlow +
                        " includeNegative=" + includeNegativeFlow +
                        " includeMultiTab=" + includeMultiTab +
                        " includeCrossBrowser=" + includeCrossBrowser +
                        " includeBoundary=" + includeBoundary +
                        " story=" + AiLoggers.truncate(body.userStory, 300)
        );

        AiService.GenerateRequest req = new AiService.GenerateRequest(
                body.userStory.trim(),
                body.acceptanceCriteria != null ? body.acceptanceCriteria : "",
                body.prompt != null ? body.prompt : "",
                body.style != null ? body.style : "strict",
                requestedCount,
                includeHappyFlow,
                includeNegativeFlow,
                includeMultiTab,
                includeCrossBrowser,
                includeBoundary
        );
        AiService ai = createAiService(selectedProvider, apiKey, model);
        List<AiService.GeneratedTestCase> result;
        try {
            result = ai.generateTestCases(req);
        } catch (Exception e) {
            AiLoggers.generationError(
                    "generation_request_failed projectId=" + projectId +
                            " userId=" + userId +
                            " provider=" + selectedProvider +
                            " model=" + model +
                            " elapsedMs=" + (System.currentTimeMillis() - startedAt),
                    e
            );
            // Surface the actual provider error message to the caller
            String detail = e.getMessage() != null ? e.getMessage() : "Unknown AI provider error";
            ctx.status(502).json(Map.of("error", detail));
            return;
        }
        String payload = serializeOrEmptyArray(result);
        UUID generationRequestId = AiGenerationHistoryService.createRecord(
                projectId,
                userId,
                new AiGenerationHistoryService.RecordCreateInput(
                        selectedProvider,
                        model,
                        body.userStory.trim(),
                        body.acceptanceCriteria,
                        body.prompt,
                        body.style,
                        requestedCount,
                        includeHappyFlow,
                        includeNegativeFlow,
                        includeMultiTab,
                        includeCrossBrowser,
                        includeBoundary,
                        result.size(),
                        payload
                )
        );
        Map<String, Object> response = new HashMap<>();
        response.put("generationRequestId", generationRequestId.toString());
        response.put("provider", selectedProvider);
        response.put("drafts", result);
        response.put("generatedCount", result.size());
        AiLoggers.generationInfo(
                "generation_request_succeeded projectId=" + projectId +
                        " userId=" + userId +
                        " provider=" + selectedProvider +
                        " generatedCount=" + result.size() +
                        " generationRequestId=" + generationRequestId +
                        " elapsedMs=" + (System.currentTimeMillis() - startedAt)
        );
        try {
            AuditService.logActivity(userId, projectId, "ai_generated", "testcase",
                    generationRequestId.toString(), result.size() + " test cases generated via AI");
        } catch (Exception ignored) {}
        ctx.json(response);
    }

    public static void listHistory(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        int limit = Math.min(100, Math.max(1, ctx.queryParamAsClass("limit", Integer.class).getOrDefault(25)));
        int offset = Math.max(0, ctx.queryParamAsClass("offset", Integer.class).getOrDefault(0));
        List<Map<String, Object>> rows = AiGenerationHistoryService.listHistory(projectId, userId, limit, offset);
        ctx.json(Map.of("list", rows));
    }

    public static void trackSave(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID requestId = UUID.fromString(ctx.pathParam("requestId"));
        SaveBody body = ctx.bodyAsClass(SaveBody.class);
        if (body == null || body.testcaseIds == null || body.testcaseIds.isEmpty()) {
            ctx.status(400).json(Map.of("error", "testcaseIds required"));
            return;
        }
        AiGenerationHistoryService.SaveEventInput saveEvent =
                AiGenerationHistoryService.SaveEventInput.from(userId, body.suiteId, body.testcaseIds);
        AiGenerationHistoryService.appendSaveEvent(projectId, requestId, userId, saveEvent);
        AiLoggers.generationInfo(
                "generation_save_recorded projectId=" + projectId +
                        " userId=" + userId +
                        " requestId=" + requestId +
                        " savedCount=" + body.testcaseIds.size() +
                        " suiteId=" + (body.suiteId == null || body.suiteId.isBlank() ? "none" : body.suiteId)
        );
        ctx.status(204);
    }

    public static void reviewScript(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canEditCases()) {
            throw new io.javalin.http.ForbiddenResponse("Cannot use AI");
        }

        ReviewScriptBody body = ctx.bodyAsClass(ReviewScriptBody.class);
        if (body == null || body.script == null || body.script.isBlank()) {
            ctx.status(400).json(Map.of("error", "script is required"));
            return;
        }
        List<String> steps = body.steps == null ? List.of() : body.steps.stream().filter(s -> s != null && !s.isBlank()).toList();

        Map<String, String> aiConfig = readAiConfig(projectId);
        String selectedProvider = normalizeProvider(aiConfig.getOrDefault("provider", "openai"));
        String apiKey = resolveProviderApiKey(selectedProvider, aiConfig);
        String model = resolveModel(selectedProvider, null, aiConfig);
        AiService ai = createAiService(selectedProvider, apiKey, model);
        if (!(ai instanceof RemoteAiService remoteAi)) {
            ctx.status(500).json(Map.of("error", "AI review engine unavailable"));
            return;
        }

        String systemPrompt = "You are a senior QA automation reviewer. Return strict JSON only.";
        String userPrompt = buildScriptReviewPrompt(body, steps);
        String raw;
        try {
            raw = remoteAi.completeText(systemPrompt, userPrompt, 0.1);
        } catch (Exception e) {
            ctx.status(502).json(Map.of("error", e.getMessage() == null ? "AI review failed" : e.getMessage()));
            return;
        }
        Map<String, Object> parsed = parseScriptReviewResponse(raw, steps);
        ctx.json(parsed);
    }

    private static String normalizeProvider(String provider) {
        if (provider == null || provider.isBlank()) return "openai";
        String normalized = provider.trim().toLowerCase();
        if (!normalized.equals("openai") && !normalized.equals("anthropic")) {
            throw new io.javalin.http.BadRequestResponse("provider must be openai or anthropic");
        }
        return normalized;
    }

    private static String resolveProviderApiKey(String provider, Map<String, String> aiConfig) {
        if (provider.equals("openai")) {
            String key = AiKeySanitizer.sanitize(aiConfig.getOrDefault("openAiApiKey", ""));
            if (key.isBlank()) {
                throw new io.javalin.http.BadRequestResponse("OpenAI API key is missing. Workspace owner must allocate an AI key to this project.");
            }
            if (AiKeySanitizer.looksLikeAnthropicKey(key)) {
                throw new io.javalin.http.BadRequestResponse(
                        "Allocated key/provider mismatch: this project is set to OpenAI but the key looks like an Anthropic key. Update Workspace Settings -> Integrations."
                );
            }
            return key;
        }
        String key = AiKeySanitizer.sanitize(aiConfig.getOrDefault("anthropicApiKey", ""));
        if (key.isBlank()) {
            throw new io.javalin.http.BadRequestResponse("Anthropic API key is missing. Workspace owner must allocate an AI key to this project.");
        }
        if (AiKeySanitizer.looksLikeOpenAiKey(key)) {
            throw new io.javalin.http.BadRequestResponse(
                    "Allocated key/provider mismatch: this project is set to Anthropic but the key looks like an OpenAI key. Update Workspace Settings -> Integrations."
            );
        }
        return key;
    }

    private static String resolveModel(String provider, String ignoredBodyModel, Map<String, String> aiConfig) {
        Set<String> allowed = "anthropic".equals(provider) ? ANTHROPIC_MODEL_OPTIONS : OPENAI_MODEL_OPTIONS;
        String settingsModel = aiConfig.getOrDefault("model", "");
        if (!settingsModel.isBlank()) {
            String candidate = settingsModel.trim();
            if (allowed.contains(candidate)) return candidate;
        }
        return allowed.iterator().next();
    }

    private static AiService createAiService(String provider, String apiKey, String model) {
        if ("anthropic".equals(provider)) {
            return new RemoteAiService(RemoteAiService.Provider.ANTHROPIC, apiKey, model);
        }
        return new RemoteAiService(RemoteAiService.Provider.OPENAI, apiKey, model);
    }

    public static Map<String, String> readAiConfig(UUID projectId) {
        String sql = """
                SELECT p.settings,
                       wak.provider AS workspace_provider,
                       wak.api_key AS workspace_api_key,
                       wak.default_model AS workspace_default_model
                FROM projects p
                LEFT JOIN project_ai_key_allocations alloc ON alloc.project_id = p.id
                LEFT JOIN workspace_ai_keys wak
                  ON wak.id = alloc.workspace_ai_key_id
                 AND wak.organization_id = p.organization_id
                 AND wak.is_active = true
                WHERE p.id = ?
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) {
                throw new io.javalin.http.NotFoundResponse("Project not found");
            }
            Map<String, String> out = new HashMap<>();
            String workspaceProvider = rs.getString("workspace_provider");
            String workspaceApiKey = AiKeySanitizer.sanitize(rs.getString("workspace_api_key"));
            String workspaceDefaultModel = rs.getString("workspace_default_model");
            if (workspaceProvider != null && workspaceApiKey != null && !workspaceApiKey.isBlank()) {
                String provider = workspaceProvider.trim().toLowerCase();
                out.put("provider", provider);
                if ("anthropic".equals(provider)) {
                    out.put("anthropicApiKey", workspaceApiKey);
                    out.remove("openAiApiKey");
                } else {
                    out.put("openAiApiKey", workspaceApiKey);
                    out.remove("anthropicApiKey");
                }
                String configuredModel = out.getOrDefault("model", "").trim();
                if (configuredModel.isBlank() && workspaceDefaultModel != null && !workspaceDefaultModel.isBlank()) {
                    out.put("model", workspaceDefaultModel.trim());
                }
            } else {
                // Keys are workspace-level. No allocation means no provider/key/model is exposed.
                out.remove("openAiApiKey");
                out.remove("anthropicApiKey");
                out.remove("provider");
                out.remove("model");
            }
            return out;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static boolean hasAssignedWorkspaceAiKey(UUID projectId) {
        String sql = """
                SELECT 1
                FROM projects p
                JOIN project_ai_key_allocations alloc ON alloc.project_id = p.id
                JOIN workspace_ai_keys wak ON wak.id = alloc.workspace_ai_key_id
                WHERE p.id = ?
                  AND wak.organization_id = p.organization_id
                  AND wak.is_active = true
                  AND wak.api_key IS NOT NULL
                  AND btrim(wak.api_key) <> ''
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ResultSet rs = ps.executeQuery();
            return rs.next();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static String serializeOrEmptyArray(Object value) {
        try {
            return mapper.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            return "[]";
        }
    }

    private static String buildScriptReviewPrompt(ReviewScriptBody body, List<String> steps) {
        StringBuilder sb = new StringBuilder();
        sb.append("Review this generated Playwright script against test intent and rerun outcome.\n");
        sb.append("Return ONLY valid JSON. No markdown. No extra text.\n\n");
        sb.append("JSON schema:\n");
        sb.append("{");
        sb.append("\"status\":\"passed|failed\",");
        sb.append("\"summary\":\"string\",");
        sb.append("\"categories\":[");
        sb.append("{\"key\":\"goal_validation|rerun_validation|plan_steps_alignment|assertion_validation\",\"passed\":true,\"detail\":\"string\"}");
        sb.append("],");
        sb.append("\"validatedSteps\":[{\"step\":\"string\",\"passed\":true,\"detail\":\"string\"}],");
        sb.append("\"feedback\":[\"string\"],");
        sb.append("\"assertionSuggestions\":[{\"step\":\"string\",\"suggestion\":\"string\",\"reason\":\"string\"}]");
        sb.append("}\n\n");
        sb.append("Rules:\n");
        sb.append("- Mark failed if rerunPassed is false.\n");
        sb.append("- Mark failed if assertions are weak/missing for business outcomes.\n");
        sb.append("- validatedSteps must include one row per provided step.\n");
        sb.append("- assertionSuggestions MUST be concrete Playwright assertions.\n");
        sb.append("- For each suggestion, include exact code-like snippet starting with 'Add: await expect(...'.\n");
        sb.append("- Reuse selectors, text, and URL anchors that appear in the provided script.\n");
        sb.append("- Do NOT return generic wording like 'add robust assertions' without code.\n");
        sb.append("- Include concrete, developer-actionable feedback.\n\n");
        sb.append("Input:\n");
        sb.append("testcaseId: ").append(body.testcaseId == null ? "" : body.testcaseId).append("\n");
        sb.append("title: ").append(body.testcaseTitle == null ? "" : body.testcaseTitle).append("\n");
        sb.append("description: ").append(body.testcaseDescription == null ? "" : body.testcaseDescription).append("\n");
        sb.append("rerunPassed: ").append(Boolean.TRUE.equals(body.rerunPassed)).append("\n");
        sb.append("rerunError: ").append(body.rerunError == null ? "" : body.rerunError).append("\n");
        sb.append("reviewInstruction: ").append(body.reviewInstruction == null ? "" : body.reviewInstruction).append("\n");
        sb.append("steps:\n");
        if (steps.isEmpty()) {
            sb.append("- (none)\n");
        } else {
            for (int i = 0; i < steps.size(); i++) {
                sb.append(i + 1).append(". ").append(steps.get(i)).append("\n");
            }
        }
        sb.append("\nscript:\n");
        sb.append(body.script);
        return sb.toString();
    }

    private static Map<String, Object> parseScriptReviewResponse(String raw, List<String> fallbackSteps) {
        String normalized = stripMarkdownCodeFences(raw == null ? "" : raw.trim());
        JsonNode root;
        try {
            root = mapper.readTree(normalized);
        } catch (Exception first) {
            String extracted = extractFirstJsonObject(normalized);
            if (extracted == null) {
                throw new io.javalin.http.BadRequestResponse("AI returned invalid review response");
            }
            try {
                root = mapper.readTree(extracted);
            } catch (Exception ignored) {
                throw new io.javalin.http.BadRequestResponse("AI returned invalid review response");
            }
        }

        String status = "failed";
        String rawStatus = root.path("status").asText("failed").trim().toLowerCase();
        if ("passed".equals(rawStatus)) status = "passed";
        String summary = root.path("summary").asText("");

        List<Map<String, Object>> categories = new ArrayList<>();
        JsonNode categoriesNode = root.path("categories");
        if (categoriesNode.isArray()) {
            for (JsonNode c : categoriesNode) {
                String key = c.path("key").asText("").trim();
                if (key.isBlank()) continue;
                Map<String, Object> row = new HashMap<>();
                row.put("key", key);
                row.put("passed", c.path("passed").asBoolean(false));
                row.put("detail", c.path("detail").asText(""));
                categories.add(row);
            }
        }

        List<Map<String, Object>> validatedSteps = new ArrayList<>();
        JsonNode stepsNode = root.path("validatedSteps");
        if (stepsNode.isArray()) {
            for (JsonNode s : stepsNode) {
                String stepText = s.path("step").asText("").trim();
                if (stepText.isBlank()) continue;
                Map<String, Object> row = new HashMap<>();
                row.put("step", stepText);
                row.put("passed", s.path("passed").asBoolean(false));
                row.put("detail", s.path("detail").asText(""));
                validatedSteps.add(row);
            }
        }
        if (validatedSteps.isEmpty() && !fallbackSteps.isEmpty()) {
            for (String step : fallbackSteps) {
                Map<String, Object> row = new HashMap<>();
                row.put("step", step);
                row.put("passed", false);
                row.put("detail", "AI did not return step-level verdict.");
                validatedSteps.add(row);
            }
        }

        List<String> feedback = new ArrayList<>();
        JsonNode feedbackNode = root.path("feedback");
        if (feedbackNode.isArray()) {
            for (JsonNode f : feedbackNode) {
                String msg = f.asText("").trim();
                if (!msg.isBlank()) feedback.add(msg);
            }
        }
        if (feedback.isEmpty() && !"passed".equals(status)) {
            feedback.add("AI review marked script as failed without detailed feedback.");
        }

        List<Map<String, Object>> assertionSuggestions = new ArrayList<>();
        JsonNode sugNode = root.path("assertionSuggestions");
        if (sugNode.isArray()) {
            for (JsonNode s : sugNode) {
                String step = s.path("step").asText("").trim();
                String suggestion = s.path("suggestion").asText("").trim();
                String reason = s.path("reason").asText("").trim();
                if (step.isBlank() && suggestion.isBlank()) continue;
                Map<String, Object> row = new HashMap<>();
                row.put("step", step);
                row.put("suggestion", suggestion);
                row.put("reason", reason);
                assertionSuggestions.add(row);
            }
        }

        Map<String, Object> out = new HashMap<>();
        out.put("status", status);
        out.put("summary", summary);
        out.put("categories", categories);
        out.put("validatedSteps", validatedSteps);
        out.put("feedback", feedback);
        out.put("assertionSuggestions", assertionSuggestions);
        return out;
    }

    private static String stripMarkdownCodeFences(String content) {
        String trimmed = content == null ? "" : content.trim();
        if (trimmed.startsWith("```")) {
            int firstNewline = trimmed.indexOf('\n');
            int lastFence = trimmed.lastIndexOf("```");
            if (firstNewline > 0 && lastFence > firstNewline) {
                return trimmed.substring(firstNewline + 1, lastFence).trim();
            }
        }
        return trimmed;
    }

    private static String extractFirstJsonObject(String text) {
        if (text == null) return null;
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
                if (depth == 0) {
                    return text.substring(start, i + 1);
                }
            }
        }
        return null;
    }

    public static class GenerateBody {
        public String userStory;
        public String acceptanceCriteria;
        public String prompt;
        public String style;
        public Integer count;
        public String provider;
        public String model;
        public Boolean includeHappyFlow;
        public Boolean includeNegativeFlow;
        public Boolean includeMultiTab;
        public Boolean includeCrossBrowser;
        public Boolean includeBoundary;
    }

    public static class SaveBody {
        public String suiteId;
        public List<String> testcaseIds;
    }

    public static class ReviewScriptBody {
        public String testcaseId;
        public String testcaseTitle;
        public String testcaseDescription;
        public List<String> steps;
        public String script;
        public Boolean rerunPassed;
        public String rerunError;
        public String reviewInstruction;
    }
}
