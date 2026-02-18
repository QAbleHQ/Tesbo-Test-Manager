package com.bettercases.ai;

import com.bettercases.Database;
import com.bettercases.audit.AuditService;
import com.bettercases.auth.SessionFilter;
import com.bettercases.rbac.RbacService;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.javalin.http.Context;

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
        String selectedProvider = normalizeProvider(
                body.provider != null ? body.provider : aiConfig.getOrDefault("provider", "openai")
        );
        String apiKey = resolveProviderApiKey(selectedProvider, aiConfig);
        String model = resolveModel(selectedProvider, body.model, aiConfig);

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
            String key = aiConfig.getOrDefault("openAiApiKey", "");
            if (key.isBlank()) {
                throw new io.javalin.http.BadRequestResponse("OpenAI API key is missing in project settings");
            }
            return key;
        }
        String key = aiConfig.getOrDefault("anthropicApiKey", "");
        if (key.isBlank()) {
            throw new io.javalin.http.BadRequestResponse("Anthropic API key is missing in project settings");
        }
        return key;
    }

    private static String resolveModel(String provider, String bodyModel, Map<String, String> aiConfig) {
        Set<String> allowed = "anthropic".equals(provider) ? ANTHROPIC_MODEL_OPTIONS : OPENAI_MODEL_OPTIONS;
        if (bodyModel != null && !bodyModel.isBlank()) {
            String candidate = bodyModel.trim();
            if (allowed.contains(candidate)) return candidate;
            return allowed.iterator().next();
        }
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

    private static Map<String, String> readAiConfig(UUID projectId) {
        String sql = "SELECT settings FROM projects WHERE id = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) {
                throw new io.javalin.http.NotFoundResponse("Project not found");
            }
            String settingsJson = rs.getString("settings");
            if (settingsJson == null || settingsJson.isBlank()) return Map.of();
            Map<String, Object> parsed = mapper.readValue(settingsJson, new TypeReference<>() {});
            Object aiSettings = parsed.get("ai");
            if (!(aiSettings instanceof Map<?, ?> aiMap)) return Map.of();
            Map<String, String> out = new HashMap<>();
            aiMap.forEach((key, value) -> {
                if (key != null && value instanceof String strValue) {
                    out.put(String.valueOf(key), strValue);
                }
            });
            return out;
        } catch (SQLException | JsonProcessingException e) {
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
}
