package com.bettercases.ai;

import com.bettercases.Database;
import com.bettercases.rbac.RbacService;
import org.postgresql.util.PGobject;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class AiGenerationHistoryService {
    private AiGenerationHistoryService() {}

    public static UUID createRecord(UUID projectId, UUID userId, RecordCreateInput input) {
        RbacService.requireProjectRole(userId, projectId);
        String sql = """
                INSERT INTO ai_generation_requests (
                    project_id, requested_by, provider, model, user_story, acceptance_criteria, custom_prompt, style,
                    requested_count, include_happy_flow, include_negative_flow, include_multi_tab, include_cross_browser,
                    include_boundary, generated_count, generated_payload
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
                RETURNING id
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ps.setObject(2, userId);
            ps.setString(3, input.provider());
            if (input.model() != null && !input.model().isBlank()) {
                ps.setString(4, input.model());
            } else {
                ps.setNull(4, Types.VARCHAR);
            }
            ps.setString(5, input.userStory());
            ps.setString(6, input.acceptanceCriteria() != null ? input.acceptanceCriteria() : "");
            ps.setString(7, input.customPrompt() != null ? input.customPrompt() : "");
            ps.setString(8, input.style() != null ? input.style() : "strict");
            ps.setInt(9, input.requestedCount());
            ps.setBoolean(10, input.includeHappyFlow());
            ps.setBoolean(11, input.includeNegativeFlow());
            ps.setBoolean(12, input.includeMultiTab());
            ps.setBoolean(13, input.includeCrossBrowser());
            ps.setBoolean(14, input.includeBoundary());
            ps.setInt(15, input.generatedCount());
            ps.setString(16, input.generatedPayloadJson());
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) throw new RuntimeException("Failed to create AI generation record");
            return (UUID) rs.getObject("id");
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static List<Map<String, Object>> listHistory(UUID projectId, UUID userId, int limit, int offset) {
        RbacService.requireProjectRole(userId, projectId);
        String sql = """
                SELECT id, requested_by, provider, model, user_story, acceptance_criteria, custom_prompt, style,
                       requested_count, include_happy_flow, include_negative_flow, include_multi_tab,
                       include_cross_browser, include_boundary, generated_count, generated_payload, saved_count,
                       save_events, created_at, updated_at
                FROM ai_generation_requests
                WHERE project_id = ?
                ORDER BY created_at DESC
                LIMIT ? OFFSET ?
                """;
        List<Map<String, Object>> rows = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ps.setInt(2, Math.max(1, Math.min(limit, 200)));
            ps.setInt(3, Math.max(offset, 0));
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                Map<String, Object> row = new HashMap<>();
                row.put("id", rs.getObject("id").toString());
                row.put("requestedBy", rs.getObject("requested_by").toString());
                row.put("provider", rs.getString("provider"));
                row.put("model", rs.getString("model"));
                row.put("userStory", rs.getString("user_story"));
                row.put("acceptanceCriteria", rs.getString("acceptance_criteria"));
                row.put("customPrompt", rs.getString("custom_prompt"));
                row.put("style", rs.getString("style"));
                row.put("requestedCount", rs.getInt("requested_count"));
                row.put("includeHappyFlow", rs.getBoolean("include_happy_flow"));
                row.put("includeNegativeFlow", rs.getBoolean("include_negative_flow"));
                row.put("includeMultiTab", rs.getBoolean("include_multi_tab"));
                row.put("includeCrossBrowser", rs.getBoolean("include_cross_browser"));
                row.put("includeBoundary", rs.getBoolean("include_boundary"));
                row.put("generatedCount", rs.getInt("generated_count"));
                row.put("generatedPayload", rs.getString("generated_payload"));
                row.put("savedCount", rs.getInt("saved_count"));
                row.put("saveEvents", rs.getString("save_events"));
                row.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
                row.put("updatedAt", rs.getTimestamp("updated_at").toInstant().toString());
                rows.add(row);
            }
            return rows;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static void appendSaveEvent(UUID projectId, UUID requestId, UUID actorId, SaveEventInput input) {
        RbacService.requireProjectRole(actorId, projectId);
        String sql = """
                UPDATE ai_generation_requests
                SET save_events = save_events || ?::jsonb,
                    saved_count = saved_count + ?,
                    updated_at = now()
                WHERE id = ? AND project_id = ?
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            PGobject eventJson = new PGobject();
            eventJson.setType("jsonb");
            eventJson.setValue(input.saveEventJson());
            ps.setObject(1, eventJson);
            ps.setInt(2, Math.max(0, input.savedCount()));
            ps.setObject(3, requestId);
            ps.setObject(4, projectId);
            int changed = ps.executeUpdate();
            if (changed == 0) {
                throw new io.javalin.http.NotFoundResponse("Generation history not found");
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public record RecordCreateInput(
            String provider,
            String model,
            String userStory,
            String acceptanceCriteria,
            String customPrompt,
            String style,
            int requestedCount,
            boolean includeHappyFlow,
            boolean includeNegativeFlow,
            boolean includeMultiTab,
            boolean includeCrossBrowser,
            boolean includeBoundary,
            int generatedCount,
            String generatedPayloadJson
    ) {}

    public record SaveEventInput(String saveEventJson, int savedCount) {
        public static SaveEventInput from(UUID actorId, String suiteId, List<String> testcaseIds) {
            int count = testcaseIds != null ? testcaseIds.size() : 0;
            StringBuilder sb = new StringBuilder();
            sb.append("[{");
            sb.append("\"savedAt\":\"").append(Instant.now().toString()).append("\",");
            sb.append("\"savedBy\":\"").append(actorId).append("\",");
            if (suiteId != null && !suiteId.isBlank()) {
                sb.append("\"suiteId\":\"").append(suiteId).append("\",");
            } else {
                sb.append("\"suiteId\":null,");
            }
            sb.append("\"savedCount\":").append(count).append(",");
            sb.append("\"testcaseIds\":[");
            if (testcaseIds != null) {
                for (int i = 0; i < testcaseIds.size(); i++) {
                    if (i > 0) sb.append(",");
                    sb.append("\"").append(testcaseIds.get(i)).append("\"");
                }
            }
            sb.append("]}]");
            return new SaveEventInput(sb.toString(), count);
        }
    }
}
