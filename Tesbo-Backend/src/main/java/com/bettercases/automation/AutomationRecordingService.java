package com.bettercases.automation;

import com.bettercases.Database;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

public final class AutomationRecordingService {
    private static final ObjectMapper mapper = new ObjectMapper();

    /**
     * Persist a recording snapshot with the unified timeline format.
     */
    public static UUID saveRecording(UUID projectId, UUID testcaseId, UUID sessionId, UUID commandId,
                                     Map<String, Object> recording) {
        UUID id = UUID.randomUUID();
        String runId = safeStr(recording.get("runId"), commandId != null ? commandId.toString() : id.toString());
        String scenarioName = safeStr(recording.get("scenarioName"), "");
        String state = safeStr(recording.get("state"), "stopped");
        String startedAt = safeStr(recording.get("startedAt"), null);
        String stoppedAt = safeStr(recording.get("stoppedAt"), null);

        List<?> timeline = recording.get("timeline") instanceof List<?> l ? l : List.of();
        Map<String, Object> stats = recording.get("stats") instanceof Map<?, ?> m
                ? safeCastMap(m)
                : computeStatsFromTimeline(timeline);

        String playwrightScript = recording.get("playwrightScript") instanceof String s ? s : null;
        if (playwrightScript == null) {
            playwrightScript = recording.get("recordedScript") instanceof String s ? s : null;
        }

        String startUrl = safeStr(recording.get("startUrl"), null);
        String finalUrl = safeStr(recording.get("finalUrl"), null);
        int durationMs = safeInt(recording.get("durationMs"), 0);
        boolean success = recording.get("success") instanceof Boolean b ? b : false;

        String sql = """
                INSERT INTO automation_recordings (
                    id, project_id, testcase_id, session_id, command_id, run_id, scenario_name, state,
                    started_at, stopped_at,
                    timeline, stats, playwright_script,
                    start_url, final_url, duration_ms, success
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?,
                    ?::timestamptz, ?::timestamptz,
                    ?::jsonb, ?::jsonb, ?,
                    ?, ?, ?, ?
                )
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, id);
            ps.setObject(2, projectId);
            ps.setObject(3, testcaseId);
            ps.setObject(4, sessionId);
            ps.setObject(5, commandId);
            ps.setString(6, runId);
            ps.setString(7, scenarioName);
            ps.setString(8, state);
            ps.setString(9, startedAt);
            ps.setString(10, stoppedAt);
            ps.setString(11, toJson(timeline));
            ps.setString(12, toJson(stats));
            ps.setString(13, playwrightScript);
            ps.setString(14, startUrl);
            ps.setString(15, finalUrl);
            ps.setInt(16, durationMs);
            ps.setBoolean(17, success);
            ps.executeUpdate();
            return id;
        } catch (SQLException e) {
            throw new RuntimeException("Failed to save recording", e);
        }
    }

    /**
     * Retrieve a recording by its ID (full data including timeline).
     */
    public static Optional<Map<String, Object>> getRecording(UUID recordingId) {
        String sql = """
                SELECT id, project_id, testcase_id, session_id, command_id, run_id, scenario_name, state,
                       started_at, stopped_at,
                       timeline, stats, playwright_script,
                       start_url, final_url, duration_ms, success,
                       created_at, updated_at
                FROM automation_recordings WHERE id = ?
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, recordingId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) return Optional.empty();
            return Optional.of(mapRow(rs, true));
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    /**
     * Find the latest recording for a given session (full data).
     */
    public static Optional<Map<String, Object>> getLatestBySession(UUID sessionId) {
        String sql = """
                SELECT id, project_id, testcase_id, session_id, command_id, run_id, scenario_name, state,
                       started_at, stopped_at,
                       timeline, stats, playwright_script,
                       start_url, final_url, duration_ms, success,
                       created_at, updated_at
                FROM automation_recordings WHERE session_id = ?
                ORDER BY created_at DESC LIMIT 1
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, sessionId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) return Optional.empty();
            return Optional.of(mapRow(rs, true));
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    /**
     * List recordings for a testcase (newest first), summary only (no timeline blob).
     */
    public static List<Map<String, Object>> listByTestcase(UUID projectId, UUID testcaseId, int limit) {
        String sql = """
                SELECT id, project_id, testcase_id, session_id, command_id, run_id, scenario_name, state,
                       started_at, stopped_at,
                       stats, playwright_script,
                       start_url, final_url, duration_ms, success,
                       created_at, updated_at
                FROM automation_recordings
                WHERE project_id = ? AND testcase_id = ?
                ORDER BY created_at DESC LIMIT ?
                """;
        List<Map<String, Object>> out = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ps.setObject(2, testcaseId);
            ps.setInt(3, Math.max(1, Math.min(limit, 100)));
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                out.add(mapRow(rs, false));
            }
            return out;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    /**
     * List recordings for a project (newest first), summary only.
     */
    public static List<Map<String, Object>> listByProject(UUID projectId, int limit) {
        String sql = """
                SELECT id, project_id, testcase_id, session_id, command_id, run_id, scenario_name, state,
                       started_at, stopped_at,
                       stats, playwright_script,
                       start_url, final_url, duration_ms, success,
                       created_at, updated_at
                FROM automation_recordings
                WHERE project_id = ?
                ORDER BY created_at DESC LIMIT ?
                """;
        List<Map<String, Object>> out = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ps.setInt(2, Math.max(1, Math.min(limit, 100)));
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                out.add(mapRow(rs, false));
            }
            return out;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static Map<String, Object> mapRow(ResultSet rs, boolean includeTimeline) throws SQLException {
        Map<String, Object> out = new HashMap<>();
        out.put("id", rs.getObject("id").toString());
        out.put("projectId", rs.getObject("project_id").toString());
        Object testcaseId = rs.getObject("testcase_id");
        out.put("testcaseId", testcaseId != null ? testcaseId.toString() : null);
        Object sessionId = rs.getObject("session_id");
        out.put("sessionId", sessionId != null ? sessionId.toString() : null);
        Object commandId = rs.getObject("command_id");
        out.put("commandId", commandId != null ? commandId.toString() : null);
        out.put("runId", rs.getString("run_id"));
        out.put("scenarioName", rs.getString("scenario_name"));
        out.put("state", rs.getString("state"));
        out.put("startedAt", rs.getTimestamp("started_at") != null ? rs.getTimestamp("started_at").toInstant().toString() : null);
        out.put("stoppedAt", rs.getTimestamp("stopped_at") != null ? rs.getTimestamp("stopped_at").toInstant().toString() : null);

        if (includeTimeline) {
            out.put("timeline", parseJson(rs.getString("timeline")));
        }
        out.put("stats", parseJson(rs.getString("stats")));
        out.put("playwrightScript", rs.getString("playwright_script"));

        out.put("startUrl", rs.getString("start_url"));
        out.put("finalUrl", rs.getString("final_url"));
        out.put("durationMs", rs.getInt("duration_ms"));
        out.put("success", rs.getBoolean("success"));
        out.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
        out.put("updatedAt", rs.getTimestamp("updated_at").toInstant().toString());
        return out;
    }

    /**
     * Compute summary stats from a unified timeline array.
     */
    private static Map<String, Object> computeStatsFromTimeline(List<?> timeline) {
        int actionCount = 0, reasoningCount = 0, resultCount = 0;
        int clickCount = 0, typeCount = 0, navigateCount = 0, waitCount = 0;
        int pressCount = 0, scrollCount = 0, assertCount = 0, playwrightLineCount = 0;

        for (Object entry : timeline) {
            if (!(entry instanceof Map<?, ?> m)) continue;
            String kind = safeStr(m.get("kind"), "");
            switch (kind) {
                case "action" -> {
                    actionCount++;
                    String action = safeStr(m.get("action"), "");
                    switch (action) {
                        case "click" -> clickCount++;
                        case "type" -> typeCount++;
                        case "navigate" -> navigateCount++;
                        case "wait" -> waitCount++;
                        case "press" -> pressCount++;
                        case "scroll" -> scrollCount++;
                    }
                    if (action.startsWith("assert")) assertCount++;
                    if (m.get("playwright") != null) playwrightLineCount++;
                }
                case "reasoning" -> reasoningCount++;
                case "result" -> resultCount++;
            }
        }

        Map<String, Object> stats = new HashMap<>();
        stats.put("totalEntries", timeline.size());
        stats.put("actionCount", actionCount);
        stats.put("reasoningCount", reasoningCount);
        stats.put("resultCount", resultCount);
        stats.put("clickCount", clickCount);
        stats.put("typeCount", typeCount);
        stats.put("navigateCount", navigateCount);
        stats.put("waitCount", waitCount);
        stats.put("pressCount", pressCount);
        stats.put("scrollCount", scrollCount);
        stats.put("assertCount", assertCount);
        stats.put("playwrightLineCount", playwrightLineCount);
        return stats;
    }

    private static String safeStr(Object value, String fallback) {
        if (value == null) return fallback;
        String s = String.valueOf(value).trim();
        if (s.isEmpty() || "null".equalsIgnoreCase(s)) return fallback;
        return s;
    }

    private static int safeInt(Object value, int fallback) {
        if (value instanceof Number n) return n.intValue();
        if (value instanceof String s) {
            try { return Integer.parseInt(s.trim()); } catch (NumberFormatException ignored) {}
        }
        return fallback;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> safeCastMap(Map<?, ?> m) {
        return (Map<String, Object>) m;
    }

    private static String toJson(Object value) {
        try {
            return mapper.writeValueAsString(value == null ? List.of() : value);
        } catch (Exception e) {
            return "[]";
        }
    }

    private static Object parseJson(String raw) {
        if (raw == null || raw.isBlank()) return null;
        try {
            return mapper.readValue(raw, new TypeReference<Object>() {});
        } catch (Exception e) {
            return null;
        }
    }

    private AutomationRecordingService() {}
}
