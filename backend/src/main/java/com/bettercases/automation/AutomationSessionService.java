package com.bettercases.automation;

import com.bettercases.Database;
import com.bettercases.rbac.RbacService;
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

public final class AutomationSessionService {
    private static final ObjectMapper mapper = new ObjectMapper();

    public static Map<String, Object> startSession(UUID projectId, UUID testcaseId, UUID userId, String startUrl) {
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).orElseThrow().canEditCases()) {
            throw new io.javalin.http.ForbiddenResponse("Cannot automate test cases");
        }
        UUID sessionId = UUID.randomUUID();
        String sql = "INSERT INTO automation_sessions (id, project_id, testcase_id, user_id, status, current_url) VALUES (?, ?, ?, ?, 'active', ?) RETURNING id, started_at";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, sessionId);
            ps.setObject(2, projectId);
            ps.setObject(3, testcaseId);
            ps.setObject(4, userId);
            ps.setString(5, startUrl);
            ResultSet rs = ps.executeQuery();
            rs.next();
            return Map.of(
                    "id", rs.getObject("id").toString(),
                    "startedAt", rs.getTimestamp("started_at").toInstant().toString()
            );
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static Optional<Map<String, Object>> getSession(UUID sessionId, UUID projectId, UUID userId) {
        RbacService.requireProjectRole(userId, projectId);
        String sql = "SELECT id, project_id, testcase_id, user_id, status, started_at, ended_at, current_url, browser_context_meta, last_screenshot_path, updated_at " +
                "FROM automation_sessions WHERE id = ? AND project_id = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, sessionId);
            ps.setObject(2, projectId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) return Optional.empty();
            Map<String, Object> out = new HashMap<>();
            out.put("id", rs.getObject("id").toString());
            out.put("projectId", rs.getObject("project_id").toString());
            out.put("testcaseId", rs.getObject("testcase_id").toString());
            out.put("userId", rs.getObject("user_id").toString());
            out.put("status", rs.getString("status"));
            out.put("startedAt", rs.getTimestamp("started_at").toInstant().toString());
            out.put("endedAt", rs.getTimestamp("ended_at") != null ? rs.getTimestamp("ended_at").toInstant().toString() : null);
            out.put("currentUrl", rs.getString("current_url"));
            out.put("browserContextMeta", rs.getString("browser_context_meta"));
            out.put("lastScreenshotPath", rs.getString("last_screenshot_path"));
            out.put("updatedAt", rs.getTimestamp("updated_at").toInstant().toString());
            out.put("events", listEvents(sessionId, 200));
            return Optional.of(out);
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static void touchState(UUID sessionId, String currentUrl, String lastScreenshotPath, Map<String, Object> browserMeta) {
        String sql = "UPDATE automation_sessions SET current_url = ?, last_screenshot_path = ?, browser_context_meta = ?::jsonb, updated_at = now() WHERE id = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, currentUrl);
            ps.setString(2, lastScreenshotPath);
            ps.setString(3, mapper.writeValueAsString(browserMeta == null ? Map.of() : browserMeta));
            ps.setObject(4, sessionId);
            ps.executeUpdate();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static void addEvent(UUID sessionId, UUID projectId, UUID testcaseId, UUID userId, UUID commandId, String eventType, String rawCommand,
                                Map<String, Object> parsedAction, Map<String, Object> executionResult, String screenshotPath) {
        String sql = "INSERT INTO automation_session_events (session_id, project_id, testcase_id, user_id, command_id, event_type, raw_command, parsed_action_json, execution_result_json, screenshot_path) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?)";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, sessionId);
            ps.setObject(2, projectId);
            ps.setObject(3, testcaseId);
            ps.setObject(4, userId);
            ps.setObject(5, commandId);
            ps.setString(6, eventType);
            ps.setString(7, maskSensitive(rawCommand));
            ps.setString(8, parsedAction == null ? null : mapper.writeValueAsString(parsedAction));
            ps.setString(9, executionResult == null ? null : mapper.writeValueAsString(executionResult));
            ps.setString(10, screenshotPath);
            ps.executeUpdate();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static List<Map<String, Object>> listEvents(UUID sessionId, int limit) {
        String sql = "SELECT id, command_id, event_type, raw_command, parsed_action_json, execution_result_json, screenshot_path, created_at " +
                "FROM automation_session_events WHERE session_id = ? ORDER BY created_at ASC LIMIT ?";
        List<Map<String, Object>> out = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, sessionId);
            ps.setInt(2, limit);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                Map<String, Object> row = new HashMap<>();
                row.put("id", rs.getObject("id").toString());
                Object commandId = rs.getObject("command_id");
                row.put("commandId", commandId != null ? commandId.toString() : null);
                row.put("eventType", rs.getString("event_type"));
                row.put("rawCommand", rs.getString("raw_command"));
                row.put("parsedAction", parseJsonObject(rs.getString("parsed_action_json")));
                row.put("executionResult", parseJsonObject(rs.getString("execution_result_json")));
                row.put("screenshotPath", rs.getString("screenshot_path"));
                row.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
                out.add(row);
            }
            return out;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static void markSessionEnded(UUID sessionId, String status) {
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("UPDATE automation_sessions SET status = ?, ended_at = now(), updated_at = now() WHERE id = ?")) {
            ps.setString(1, status);
            ps.setObject(2, sessionId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static void markSessionStartFailed(UUID sessionId, String message) {
        String sql = """
                UPDATE automation_sessions
                SET status = 'failed',
                    current_url = ?,
                    ended_at = now(),
                    updated_at = now()
                WHERE id = ?
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, message == null ? "" : message);
            ps.setObject(2, sessionId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static void finalizeIntoTestcase(UUID projectId, UUID testcaseId, UUID userId,
                                            String framework, String repo, String path, String testName, String script,
                                            List<Map<String, Object>> generatedSteps) {
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).orElseThrow().canEditCases()) {
            throw new io.javalin.http.ForbiddenResponse("Cannot finalize automation");
        }
        try (Connection c = Database.getDataSource().getConnection()) {
            int nextVersion = 1;
            try (PreparedStatement ps = c.prepareStatement("SELECT COALESCE(MAX(version), 0) + 1 FROM testcase_versions WHERE testcase_id = ?")) {
                ps.setObject(1, testcaseId);
                ResultSet rs = ps.executeQuery();
                rs.next();
                nextVersion = rs.getInt(1);
            }
            try (PreparedStatement ins = c.prepareStatement(
                    "INSERT INTO testcase_versions (testcase_id, version, snapshot) " +
                            "SELECT id, ?, jsonb_build_object(" +
                            "'title', title, 'description', description, 'preconditions', preconditions, 'postconditions', postconditions, " +
                            "'steps', steps, 'test_data', test_data, 'estimated_duration', estimated_duration, 'attachments', attachments, " +
                            "'priority', priority, 'severity', severity, 'type', type, 'automation_status', automation_status, " +
                            "'automation_repo', automation_repo, 'automation_path', automation_path, 'automation_test_name', automation_test_name, " +
                            "'automation_framework', automation_framework, 'automation_tags', automation_tags, " +
                            "'automation_script', automation_script, 'automation_script_language', automation_script_language, " +
                            "'automation_script_version', automation_script_version, 'status', status) " +
                            "FROM testcases WHERE id = ?")) {
                ins.setInt(1, nextVersion);
                ins.setObject(2, testcaseId);
                ins.executeUpdate();
            }
            try (PreparedStatement up = c.prepareStatement(
                    "UPDATE testcases SET automation_status = 'Automated', automation_framework = ?, automation_repo = ?, automation_path = ?, " +
                            "automation_test_name = ?, automation_script = ?, automation_script_language = 'playwright-ts', " +
                            "automation_script_version = COALESCE(automation_script_version, 0) + 1, steps = COALESCE(?::jsonb, steps), automated_at = now(), automated_by = ?, updated_at = now() " +
                            "WHERE id = ? AND project_id = ?")) {
                String generatedStepsJson = null;
                if (generatedSteps != null) {
                    generatedStepsJson = mapper.writeValueAsString(generatedSteps);
                }
                up.setString(1, framework);
                up.setString(2, repo);
                up.setString(3, path);
                up.setString(4, testName);
                up.setString(5, script);
                up.setString(6, generatedStepsJson);
                up.setObject(7, userId);
                up.setObject(8, testcaseId);
                up.setObject(9, projectId);
                up.executeUpdate();
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> parseJsonObject(String raw) {
        if (raw == null || raw.isBlank()) return null;
        try {
            return mapper.readValue(raw, new TypeReference<>() {});
        } catch (Exception e) {
            return null;
        }
    }

    private static String maskSensitive(String raw) {
        if (raw == null || raw.isBlank()) return raw;
        return raw.replaceAll("(?i)(password\\s*[:=]\\s*)(\\S+)", "$1***");
    }

    private AutomationSessionService() {}
}
