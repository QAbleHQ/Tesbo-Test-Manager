package com.bettercases.tesbo;

import com.bettercases.Database;
import com.bettercases.auth.EmailService;
import com.bettercases.rbac.RbacService;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.security.SecureRandom;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

public final class TesboReportsService {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final EmailService EMAIL = new EmailService();

    private TesboReportsService() {}

    public static List<Map<String, Object>> listRuns(UUID projectId, UUID userId) {
        RbacService.requireProjectRole(userId, projectId);
        String sql = """
            SELECT r.id, r.project_id, r.name, r.status, r.started_at, r.ended_at, r.created_at,
                   r.branch_name, r.pull_request, r.commit_author, r.run_number, r.source_type, r.github_run_id,
                   COUNT(c.id) AS total,
                   COUNT(*) FILTER (WHERE c.status = 'Passed') AS passed,
                   COUNT(*) FILTER (WHERE c.status = 'Failed') AS failed,
                   COUNT(*) FILTER (WHERE c.status = 'Skipped') AS skipped
            FROM tesbo_report_runs r
            LEFT JOIN tesbo_report_cases c ON c.run_id = r.id
            WHERE r.project_id = ?
            GROUP BY r.id
            ORDER BY r.created_at DESC
            """;
        List<Map<String, Object>> out = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) out.add(mapRunRow(rs));
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return out;
    }

    public static Optional<Map<String, Object>> getRun(UUID projectId, UUID userId, UUID runId) {
        RbacService.requireProjectRole(userId, projectId);
        String sql = """
            SELECT r.id, r.project_id, r.name, r.status, r.started_at, r.ended_at, r.created_at,
                   r.branch_name, r.pull_request, r.commit_author, r.run_number, r.source_type, r.github_run_id,
                   COUNT(c.id) AS total,
                   COUNT(*) FILTER (WHERE c.status = 'Passed') AS passed,
                   COUNT(*) FILTER (WHERE c.status = 'Failed') AS failed,
                   COUNT(*) FILTER (WHERE c.status = 'Skipped') AS skipped,
                   COUNT(DISTINCT c.spec_name) AS spec_count
            FROM tesbo_report_runs r
            LEFT JOIN tesbo_report_cases c ON c.run_id = r.id
            WHERE r.project_id = ? AND r.id = ?
            GROUP BY r.id
            """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ps.setObject(2, runId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) return Optional.empty();
            Map<String, Object> run = mapRunRow(rs);
            run.put("specCount", rs.getInt("spec_count"));
            run.put("cases", listRunCases(c, projectId, runId));
            return Optional.of(run);
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static List<Map<String, Object>> listRunCases(Connection c, UUID projectId, UUID runId) throws SQLException {
        String sql = """
            SELECT id, spec_name, test_name, full_title, status, duration_ms, trace_url, screenshot_url, video_url,
                   trace_storage_key, screenshot_storage_key, video_storage_key
                   ,error_message, error_stack, attempt, project_name, browser_name, browser_version,
                   os_name, os_platform, os_arch, tags_json, steps_json
            FROM tesbo_report_cases
            WHERE run_id = ?
            ORDER BY executed_at DESC NULLS LAST, test_name
            """;
        List<Map<String, Object>> out = new ArrayList<>();
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, runId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("caseId", rs.getObject("id").toString());
                row.put("specName", rs.getString("spec_name"));
                row.put("title", rs.getString("test_name"));
                row.put("fullTitle", rs.getString("full_title"));
                row.put("status", rs.getString("status"));
                row.put("durationMs", rs.getObject("duration_ms") == null ? null : rs.getInt("duration_ms"));
                String caseId = rs.getObject("id").toString();
                row.put("traceUrl", buildArtifactUrl(projectId, caseId, "trace", rs.getString("trace_storage_key"), rs.getString("trace_url")));
                row.put("screenshotUrl", buildArtifactUrl(projectId, caseId, "screenshot", rs.getString("screenshot_storage_key"), rs.getString("screenshot_url")));
                row.put("videoUrl", buildArtifactUrl(projectId, caseId, "video", rs.getString("video_storage_key"), rs.getString("video_url")));
                row.put("errorMessage", rs.getString("error_message"));
                row.put("errorStack", rs.getString("error_stack"));
                row.put("attempt", rs.getObject("attempt") == null ? null : rs.getInt("attempt"));
                row.put("projectName", rs.getString("project_name"));
                row.put("browserName", rs.getString("browser_name"));
                row.put("browserVersion", rs.getString("browser_version"));
                row.put("osName", rs.getString("os_name"));
                row.put("osPlatform", rs.getString("os_platform"));
                row.put("osArch", rs.getString("os_arch"));
                row.put("tags", parseStringList(rs.getString("tags_json")));
                row.put("steps", parseSteps(rs.getString("steps_json")));
                out.add(row);
            }
        }
        return out;
    }

    public static List<Map<String, Object>> listSpecs(UUID projectId, UUID userId) {
        RbacService.requireProjectRole(userId, projectId);
        String sql = """
            SELECT c.spec_name,
                   COUNT(DISTINCT c.run_id) AS total_runs,
                   MAX(c.executed_at) AS latest_run_at,
                   COUNT(*) FILTER (WHERE c.status = 'Passed') AS passed,
                   COUNT(*) FILTER (WHERE c.status = 'Failed') AS failed,
                   COUNT(*) FILTER (WHERE c.status = 'Skipped') AS skipped
            FROM tesbo_report_cases c
            WHERE c.project_id = ?
            GROUP BY c.spec_name
            ORDER BY c.spec_name
            """;
        List<Map<String, Object>> out = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("specName", rs.getString("spec_name"));
                row.put("totalRuns", rs.getInt("total_runs"));
                Timestamp latest = rs.getTimestamp("latest_run_at");
                row.put("latestRunAt", latest != null ? latest.toInstant().toString() : null);
                row.put("passed", rs.getInt("passed"));
                row.put("failed", rs.getInt("failed"));
                row.put("skipped", rs.getInt("skipped"));
                out.add(row);
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return out;
    }

    public static Map<String, Object> getSpec(UUID projectId, UUID userId, String specName) {
        RbacService.requireProjectRole(userId, projectId);
        String sql = """
            SELECT test_name,
                   COUNT(*) AS total_runs,
                   COUNT(*) FILTER (WHERE status = 'Passed') AS passed,
                   COUNT(*) FILTER (WHERE status = 'Failed') AS failed,
                   COUNT(*) FILTER (WHERE status = 'Skipped') AS skipped,
                   (ARRAY_AGG(status ORDER BY executed_at DESC NULLS LAST))[1] AS latest_status
            FROM tesbo_report_cases
            WHERE project_id = ? AND spec_name = ?
            GROUP BY test_name
            ORDER BY test_name
            """;
        List<Map<String, Object>> tests = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ps.setString(2, specName);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("testName", rs.getString("test_name"));
                row.put("latestStatus", rs.getString("latest_status"));
                row.put("totalRuns", rs.getInt("total_runs"));
                row.put("passed", rs.getInt("passed"));
                row.put("failed", rs.getInt("failed"));
                row.put("skipped", rs.getInt("skipped"));
                tests.add(row);
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return Map.of("specName", specName, "tests", tests);
    }

    public static Map<String, Object> getTestHistory(UUID projectId, UUID userId, String specName, String testName) {
        RbacService.requireProjectRole(userId, projectId);
        String sql = """
            SELECT r.id AS run_id, r.name AS run_name, c.status, c.executed_at
            FROM tesbo_report_cases c
            JOIN tesbo_report_runs r ON r.id = c.run_id
            WHERE c.project_id = ? AND c.spec_name = ? AND c.test_name = ?
            ORDER BY c.executed_at DESC NULLS LAST, r.created_at DESC
            """;
        List<Map<String, Object>> runs = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ps.setString(2, specName);
            ps.setString(3, testName);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("runId", rs.getObject("run_id").toString());
                row.put("runName", rs.getString("run_name"));
                row.put("status", rs.getString("status"));
                Timestamp ts = rs.getTimestamp("executed_at");
                row.put("executedAt", ts != null ? ts.toInstant().toString() : null);
                runs.add(row);
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return Map.of("specName", specName, "testName", testName, "runs", runs);
    }

    public static List<Map<String, Object>> listTests(UUID projectId, UUID userId) {
        RbacService.requireProjectRole(userId, projectId);
        String sql = """
            SELECT spec_name, test_name,
                   (ARRAY_AGG(status ORDER BY executed_at DESC NULLS LAST))[1] AS latest_status,
                   MAX(executed_at) AS latest_run_at,
                   COUNT(*) AS total_runs,
                   COUNT(*) FILTER (WHERE status = 'Passed') AS passed,
                   COUNT(*) FILTER (WHERE status = 'Failed') AS failed,
                   COUNT(*) FILTER (WHERE status = 'Skipped') AS skipped
            FROM tesbo_report_cases
            WHERE project_id = ?
            GROUP BY spec_name, test_name
            ORDER BY spec_name, test_name
            """;
        List<Map<String, Object>> out = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("specName", rs.getString("spec_name"));
                row.put("testName", rs.getString("test_name"));
                row.put("latestStatus", rs.getString("latest_status"));
                Timestamp latest = rs.getTimestamp("latest_run_at");
                row.put("latestRunAt", latest != null ? latest.toInstant().toString() : null);
                row.put("totalRuns", rs.getInt("total_runs"));
                row.put("passed", rs.getInt("passed"));
                row.put("failed", rs.getInt("failed"));
                row.put("skipped", rs.getInt("skipped"));
                out.add(row);
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return out;
    }

    public static Map<String, Object> analytics(UUID projectId, UUID userId) {
        RbacService.requireProjectRole(userId, projectId);
        Map<String, Object> out = new LinkedHashMap<>();
        try (Connection c = Database.getDataSource().getConnection()) {
            out.put("totalRuns", queryCount(c, "SELECT COUNT(*) FROM tesbo_report_runs WHERE project_id = ?", projectId));
            out.put("totalTests", queryCount(c, "SELECT COUNT(*) FROM tesbo_report_cases WHERE project_id = ?", projectId));
            int passed = queryCount(c, "SELECT COUNT(*) FROM tesbo_report_cases WHERE project_id = ? AND status = 'Passed'", projectId);
            int total = queryCount(c, "SELECT COUNT(*) FROM tesbo_report_cases WHERE project_id = ?", projectId);
            out.put("passRate", total == 0 ? 0 : Math.round(((passed * 10000.0) / total)) / 100.0);

            Map<String, Integer> byStatus = new LinkedHashMap<>();
            String statusSql = """
                SELECT status, COUNT(*) AS cnt
                FROM tesbo_report_cases
                WHERE project_id = ?
                GROUP BY status
                """;
            try (PreparedStatement ps = c.prepareStatement(statusSql)) {
                ps.setObject(1, projectId);
                ResultSet rs = ps.executeQuery();
                while (rs.next()) byStatus.put(rs.getString("status"), rs.getInt("cnt"));
            }
            out.put("byStatus", byStatus);

            List<Map<String, Object>> runsByDay = new ArrayList<>();
            String daySql = """
                SELECT DATE(created_at) AS day, COUNT(*) AS cnt
                FROM tesbo_report_runs
                WHERE project_id = ? AND created_at >= NOW() - INTERVAL '30 day'
                GROUP BY DATE(created_at)
                ORDER BY day
                """;
            try (PreparedStatement ps = c.prepareStatement(daySql)) {
                ps.setObject(1, projectId);
                ResultSet rs = ps.executeQuery();
                while (rs.next()) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("day", rs.getString("day"));
                    row.put("count", rs.getInt("cnt"));
                    runsByDay.add(row);
                }
            }
            out.put("runsByDay", runsByDay);
            return out;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static List<Map<String, Object>> listAlerts(UUID projectId, UUID userId) {
        RbacService.requireProjectRole(userId, projectId);
        String sql = """
            SELECT id, name, condition_type, comparator, threshold, recipients_json, frequency, enabled, created_at, updated_at
            FROM tesbo_alert_rules
            WHERE project_id = ?
            ORDER BY created_at DESC
            """;
        List<Map<String, Object>> out = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) out.add(mapAlertRow(rs));
            return out;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static Map<String, Object> createAlert(UUID projectId, UUID userId, Map<String, Object> payload) {
        if (!RbacService.requireProjectRole(userId, projectId).canManageProject()) {
            throw new io.javalin.http.ForbiddenResponse("Cannot manage Tesbo alerts");
        }
        String sql = """
            INSERT INTO tesbo_alert_rules (project_id, name, condition_type, comparator, threshold, recipients_json, frequency, enabled, created_by)
            VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)
            RETURNING id, name, condition_type, comparator, threshold, recipients_json, frequency, enabled, created_at, updated_at
            """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ps.setString(2, asText(payload.get("name"), "Rule"));
            ps.setString(3, asText(payload.get("conditionType"), "FAILURE_RATIO"));
            ps.setString(4, asText(payload.get("comparator"), "GREATER_THAN"));
            ps.setObject(5, asNullableInt(payload.get("threshold")));
            ps.setString(6, recipientsJson(payload.get("recipients")));
            ps.setString(7, asText(payload.get("frequency"), "IMMEDIATE"));
            ps.setBoolean(8, asBoolean(payload.get("enabled"), true));
            ps.setObject(9, userId);
            ResultSet rs = ps.executeQuery();
            rs.next();
            return mapAlertRow(rs);
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static Map<String, Object> updateAlert(UUID projectId, UUID userId, UUID alertId, Map<String, Object> payload) {
        if (!RbacService.requireProjectRole(userId, projectId).canManageProject()) {
            throw new io.javalin.http.ForbiddenResponse("Cannot manage Tesbo alerts");
        }
        String sql = """
            UPDATE tesbo_alert_rules
            SET name = ?, condition_type = ?, comparator = ?, threshold = ?, recipients_json = ?::jsonb,
                frequency = ?, enabled = ?, updated_at = now()
            WHERE id = ? AND project_id = ?
            RETURNING id, name, condition_type, comparator, threshold, recipients_json, frequency, enabled, created_at, updated_at
            """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, asText(payload.get("name"), "Rule"));
            ps.setString(2, asText(payload.get("conditionType"), "FAILURE_RATIO"));
            ps.setString(3, asText(payload.get("comparator"), "GREATER_THAN"));
            ps.setObject(4, asNullableInt(payload.get("threshold")));
            ps.setString(5, recipientsJson(payload.get("recipients")));
            ps.setString(6, asText(payload.get("frequency"), "IMMEDIATE"));
            ps.setBoolean(7, asBoolean(payload.get("enabled"), true));
            ps.setObject(8, alertId);
            ps.setObject(9, projectId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) throw new io.javalin.http.NotFoundResponse("Alert not found");
            return mapAlertRow(rs);
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static void deleteAlert(UUID projectId, UUID userId, UUID alertId) {
        if (!RbacService.requireProjectRole(userId, projectId).canManageProject()) {
            throw new io.javalin.http.ForbiddenResponse("Cannot manage Tesbo alerts");
        }
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("DELETE FROM tesbo_alert_rules WHERE id = ? AND project_id = ?")) {
            ps.setObject(1, alertId);
            ps.setObject(2, projectId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static Map<String, Object> toggleAlert(UUID projectId, UUID userId, UUID alertId, boolean enabled) {
        if (!RbacService.requireProjectRole(userId, projectId).canManageProject()) {
            throw new io.javalin.http.ForbiddenResponse("Cannot manage Tesbo alerts");
        }
        String sql = """
            UPDATE tesbo_alert_rules SET enabled = ?, updated_at = now()
            WHERE id = ? AND project_id = ?
            RETURNING id, name, condition_type, comparator, threshold, recipients_json, frequency, enabled, created_at, updated_at
            """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setBoolean(1, enabled);
            ps.setObject(2, alertId);
            ps.setObject(3, projectId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) throw new io.javalin.http.NotFoundResponse("Alert not found");
            return mapAlertRow(rs);
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static void sendTestAlert(UUID projectId, UUID userId, UUID alertId) {
        RbacService.requireProjectRole(userId, projectId);
        String sql = """
            SELECT a.name, a.condition_type, a.comparator, a.threshold, a.recipients_json,
                   p.name AS project_name
            FROM tesbo_alert_rules a
            JOIN projects p ON p.id = a.project_id
            WHERE a.id = ? AND a.project_id = ?
            """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, alertId);
            ps.setObject(2, projectId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) throw new io.javalin.http.NotFoundResponse("Alert not found");
            List<String> recipients = parseRecipients(rs.getString("recipients_json"));
            if (recipients.isEmpty()) {
                throw new io.javalin.http.BadRequestResponse("Alert has no recipients configured");
            }
            String subject = "[Tesbo Alert Test] " + rs.getString("name");
            String body = """
                This is a test alert from TesboX Tesbo Reports.

                Project: %s
                Rule: %s
                Condition: %s %s %s
                Triggered by: %s
                Triggered at: %s
                """.formatted(
                rs.getString("project_name"),
                rs.getString("name"),
                rs.getString("condition_type"),
                rs.getString("comparator"),
                rs.getObject("threshold"),
                userId,
                Instant.now()
            );
            for (String recipient : recipients) {
                EMAIL.sendEmail(recipient, subject, body);
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static Map<String, Object> getShareState(UUID projectId, UUID userId, UUID runId, String apiBaseUrl) {
        RbacService.requireProjectRole(userId, projectId);
        String sql = """
            SELECT s.enabled, s.token
            FROM tesbo_run_shares s
            JOIN tesbo_report_runs r ON r.id = s.run_id
            WHERE s.run_id = ? AND r.project_id = ?
            """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, runId);
            ps.setObject(2, projectId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) {
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("enabled", false);
                out.put("token", null);
                out.put("publicUrl", null);
                return out;
            }
            String token = rs.getString("token");
            boolean enabled = rs.getBoolean("enabled");
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("enabled", enabled);
            out.put("token", token);
            out.put("publicUrl", (enabled && token != null) ? (apiBaseUrl + "/api/public/tesbo-reports/" + token) : null);
            return out;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static Map<String, Object> createShare(UUID projectId, UUID userId, UUID runId, int expiresInHours, String apiBaseUrl) {
        if (!RbacService.requireProjectRole(userId, projectId).canManageProject()) {
            throw new io.javalin.http.ForbiddenResponse("Cannot manage sharing");
        }
        String token = generateToken();
        String sql = """
            INSERT INTO tesbo_run_shares (run_id, token, enabled, expires_at, created_by)
            SELECT ?, ?, true, now() + (? || ' hours')::interval, ?
            WHERE EXISTS (SELECT 1 FROM tesbo_report_runs WHERE id = ? AND project_id = ?)
            ON CONFLICT (run_id) DO UPDATE
            SET token = EXCLUDED.token,
                enabled = true,
                expires_at = EXCLUDED.expires_at,
                updated_at = now()
            RETURNING token, enabled
            """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, runId);
            ps.setString(2, token);
            ps.setInt(3, Math.max(1, expiresInHours));
            ps.setObject(4, userId);
            ps.setObject(5, runId);
            ps.setObject(6, projectId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) throw new io.javalin.http.NotFoundResponse("Run not found");
            String createdToken = rs.getString("token");
            return Map.of(
                "enabled", rs.getBoolean("enabled"),
                "token", createdToken,
                "publicUrl", apiBaseUrl + "/api/public/tesbo-reports/" + createdToken
            );
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static void disableShare(UUID projectId, UUID userId, UUID runId) {
        if (!RbacService.requireProjectRole(userId, projectId).canManageProject()) {
            throw new io.javalin.http.ForbiddenResponse("Cannot manage sharing");
        }
        String sql = """
            UPDATE tesbo_run_shares s
            SET enabled = false, updated_at = now()
            FROM tesbo_report_runs r
            WHERE s.run_id = r.id AND s.run_id = ? AND r.project_id = ?
            """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, runId);
            ps.setObject(2, projectId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static Optional<Map<String, Object>> getSharedRunByToken(String token) {
        String sql = """
            SELECT r.id, r.project_id, r.name, r.status, r.started_at, r.ended_at, r.created_at,
                   r.branch_name, r.pull_request, r.commit_author, r.run_number, r.source_type, r.github_run_id,
                   COUNT(c.id) AS total,
                   COUNT(*) FILTER (WHERE c.status = 'Passed') AS passed,
                   COUNT(*) FILTER (WHERE c.status = 'Failed') AS failed,
                   COUNT(*) FILTER (WHERE c.status = 'Skipped') AS skipped,
                   COUNT(DISTINCT c.spec_name) AS spec_count
            FROM tesbo_run_shares s
            JOIN tesbo_report_runs r ON r.id = s.run_id
            LEFT JOIN tesbo_report_cases c ON c.run_id = r.id
            WHERE s.token = ? AND s.enabled = true AND (s.expires_at IS NULL OR s.expires_at > now())
            GROUP BY r.id
            """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, token);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) return Optional.empty();
            Map<String, Object> out = mapRunRow(rs);
            out.put("specCount", rs.getInt("spec_count"));
            out.put("cases", listRunCasesForShare(c, (UUID) rs.getObject("id"), token));
            out.put("shareEnabled", true);
            return Optional.of(out);
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static TesboArtifactStorageService.ArtifactReadResult getSharedCaseArtifact(String token, UUID caseId, String kind) {
        String sql = """
            SELECT c.trace_url, c.screenshot_url, c.video_url, c.trace_storage_key, c.screenshot_storage_key, c.video_storage_key
            FROM tesbo_run_shares s
            JOIN tesbo_report_runs r ON r.id = s.run_id
            JOIN tesbo_report_cases c ON c.run_id = r.id
            WHERE s.token = ? AND c.id = ? AND s.enabled = true AND (s.expires_at IS NULL OR s.expires_at > now())
            """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, token);
            ps.setObject(2, caseId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) {
                throw new io.javalin.http.NotFoundResponse("Artifact not found");
            }
            String normalized = normalizeArtifactKind(kind);
            return switch (normalized) {
                case "trace" -> TesboArtifactStorageService.read(rs.getString("trace_storage_key"), rs.getString("trace_url"), "application/zip");
                case "screenshot" -> TesboArtifactStorageService.read(rs.getString("screenshot_storage_key"), rs.getString("screenshot_url"), "image/png");
                case "video" -> TesboArtifactStorageService.read(rs.getString("video_storage_key"), rs.getString("video_url"), "video/webm");
                default -> null;
            };
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static Map<String, Object> getSettings(UUID projectId, UUID userId) {
        RbacService.requireProjectRole(userId, projectId);
        Map<String, Object> settings = readProjectSettings(projectId);
        Map<String, Object> tesbo = asMap(settings.get("tesboReports"));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("keepTrace", asBoolean(tesbo.get("keepTrace"), true));
        out.put("traceRetentionDays", asNullableInt(tesbo.get("traceRetentionDays")) == null ? 14 : asNullableInt(tesbo.get("traceRetentionDays")));
        out.put("ingestionApiKey", asText(tesbo.get("ingestionApiKey"), ""));
        out.put("alertsEnabled", asBoolean(tesbo.get("alertsEnabled"), true));
        out.put("shareByDefault", asBoolean(tesbo.get("shareByDefault"), false));
        return out;
    }

    public static Map<String, Object> rotateIngestionKey(UUID projectId, UUID userId) {
        if (!RbacService.requireProjectRole(userId, projectId).canManageProject()) {
            throw new io.javalin.http.ForbiddenResponse("Cannot rotate project access key");
        }
        Map<String, Object> root = readProjectSettings(projectId);
        Map<String, Object> tesbo = asMap(root.get("tesboReports"));
        String key = "tesbo_" + generateToken();
        tesbo.put("ingestionApiKey", key);
        root.put("tesboReports", tesbo);
        writeProjectSettings(projectId, root);
        return Map.of("ingestionApiKey", key);
    }

    public static Map<String, Object> updateSettings(UUID projectId, UUID userId, Map<String, Object> payload) {
        if (!RbacService.requireProjectRole(userId, projectId).canManageProject()) {
            throw new io.javalin.http.ForbiddenResponse("Cannot manage settings");
        }
        Map<String, Object> root = readProjectSettings(projectId);
        Map<String, Object> tesbo = asMap(root.get("tesboReports"));
        tesbo.put("keepTrace", asBoolean(payload.get("keepTrace"), asBoolean(tesbo.get("keepTrace"), true)));
        Integer retention = asNullableInt(payload.get("traceRetentionDays"));
        tesbo.put("traceRetentionDays", retention != null ? retention : asNullableInt(tesbo.get("traceRetentionDays")) == null ? 14 : asNullableInt(tesbo.get("traceRetentionDays")));
        tesbo.put("ingestionApiKey", asText(payload.get("ingestionApiKey"), asText(tesbo.get("ingestionApiKey"), "")));
        tesbo.put("alertsEnabled", asBoolean(payload.get("alertsEnabled"), asBoolean(tesbo.get("alertsEnabled"), true)));
        tesbo.put("shareByDefault", asBoolean(payload.get("shareByDefault"), asBoolean(tesbo.get("shareByDefault"), false)));
        root.put("tesboReports", tesbo);
        writeProjectSettings(projectId, root);
        return getSettings(projectId, userId);
    }

    public static Map<String, Object> ingestPlaywright(UUID projectId, UUID userId, Map<String, Object> body) {
        if (!RbacService.requireProjectRole(userId, projectId).canExportImport()) {
            throw new io.javalin.http.ForbiddenResponse("Cannot ingest Tesbo run data");
        }
        return ingestPlaywrightInternal(projectId, userId, body);
    }

    public static Map<String, Object> ingestPlaywrightWithIngestionKey(UUID projectId, String ingestionKey, Map<String, Object> body) {
        requireValidIngestionKey(projectId, ingestionKey);
        return ingestPlaywrightInternal(projectId, null, body);
    }

    public static Map<String, Object> ingestPlaywrightWithIngestionKey(String ingestionKey, Map<String, Object> body) {
        UUID projectId = resolveProjectIdByIngestionKey(ingestionKey);
        return ingestPlaywrightInternal(projectId, null, body);
    }

    private static Map<String, Object> ingestPlaywrightInternal(UUID projectId, UUID createdByUserId, Map<String, Object> body) {
        Map<String, Object> payload = asMap(body.get("payload"));
        if (payload.isEmpty() && (body.containsKey("tests") || body.containsKey("runName"))) {
            payload = body;
        }
        String runName = asText(payload.get("runName"), "Ingested Tesbo Run");
        String status = asText(payload.get("status"), "COMPLETED");
        String branchName = asText(payload.get("branchName"), null);
        String pullRequest = asText(payload.get("pullRequest"), null);
        String commitAuthor = asText(payload.get("commitAuthor"), null);
        String runNumber = asText(payload.get("runNumber"), null);
        String sourceType = asText(payload.get("sourceType"), "PLAYWRIGHT");
        String githubRunId = asText(payload.get("githubRunId"), null);
        Instant startedAt = parseInstant(payload.get("startedAt"), Instant.now());
        Instant completedAt = parseInstant(payload.get("completedAt"), startedAt);

        String insertRunSql = """
            INSERT INTO tesbo_report_runs
            (project_id, name, status, started_at, ended_at, created_by, branch_name, pull_request, commit_author, run_number, source_type, github_run_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
            """;

        try (Connection c = Database.getDataSource().getConnection()) {
            c.setAutoCommit(false);
            UUID runId;
            try (PreparedStatement ps = c.prepareStatement(insertRunSql)) {
                ps.setObject(1, projectId);
                ps.setString(2, runName);
                ps.setString(3, status);
                ps.setTimestamp(4, Timestamp.from(startedAt));
                ps.setTimestamp(5, Timestamp.from(completedAt));
                ps.setObject(6, createdByUserId);
                ps.setString(7, branchName);
                ps.setString(8, pullRequest);
                ps.setString(9, commitAuthor);
                ps.setString(10, runNumber);
                ps.setString(11, sourceType);
                ps.setString(12, githubRunId);
                ResultSet rs = ps.executeQuery();
                rs.next();
                runId = (UUID) rs.getObject("id");
            }

            List<Map<String, Object>> tests = castListOfMaps(payload.get("tests"));
            String insertCaseSql = """
                INSERT INTO tesbo_report_cases
                (id, run_id, project_id, spec_name, test_name, status, duration_ms, trace_url, screenshot_url, video_url,
                 trace_storage_key, screenshot_storage_key, video_storage_key,
                 full_title, error_message, error_stack, attempt,
                 project_name, browser_name, browser_version, os_name, os_platform, os_arch,
                 tags_json, steps_json, executed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?)
                """;
            try (PreparedStatement ps = c.prepareStatement(insertCaseSql)) {
                for (Map<String, Object> test : tests) {
                    UUID caseId = parseUuid(test.get("caseId")).orElseGet(UUID::randomUUID);
                    String traceContentType = asText(test.get("traceContentType"), "application/zip");
                    String screenshotContentType = asText(test.get("screenshotContentType"), "image/png");
                    String videoContentType = asText(test.get("videoContentType"), "video/webm");

                    byte[] traceBytes = TesboArtifactStorageService.decodeBase64(test.get("traceBase64"));
                    byte[] screenshotBytes = TesboArtifactStorageService.decodeBase64(test.get("screenshotBase64"));
                    byte[] videoBytes = TesboArtifactStorageService.decodeBase64(test.get("videoBase64"));

                    TesboArtifactStorageService.ArtifactLocation traceLocation = saveArtifact(projectId, runId, caseId, "trace", traceContentType, traceBytes);
                    TesboArtifactStorageService.ArtifactLocation screenshotLocation = saveArtifact(projectId, runId, caseId, "screenshot", screenshotContentType, screenshotBytes);
                    TesboArtifactStorageService.ArtifactLocation videoLocation = saveArtifact(projectId, runId, caseId, "video", videoContentType, videoBytes);

                    ps.setObject(1, caseId);
                    ps.setObject(2, runId);
                    ps.setObject(3, projectId);
                    ps.setString(4, asText(test.get("spec"), "unknown.spec"));
                    ps.setString(5, asText(test.get("name"), "Unnamed test"));
                    ps.setString(6, asText(test.get("status"), "Unknown"));
                    Integer duration = asNullableInt(test.get("durationMs"));
                    ps.setObject(7, duration);
                    ps.setString(8, asText(test.get("traceUrl"), null));
                    ps.setString(9, asText(test.get("screenshotUrl"), null));
                    ps.setString(10, asText(test.get("videoUrl"), null));
                    ps.setString(11, traceLocation != null ? traceLocation.storageKey() : null);
                    ps.setString(12, screenshotLocation != null ? screenshotLocation.storageKey() : null);
                    ps.setString(13, videoLocation != null ? videoLocation.storageKey() : null);
                    ps.setString(14, asText(test.get("fullTitle"), null));
                    ps.setString(15, asText(test.get("errorMessage"), null));
                    ps.setString(16, asText(test.get("errorStack"), null));
                    ps.setObject(17, asNullableInt(test.get("attempt")));
                    ps.setString(18, asText(test.get("projectName"), null));
                    ps.setString(19, asText(test.get("browserName"), null));
                    ps.setString(20, asText(test.get("browserVersion"), null));
                    ps.setString(21, asText(test.get("osName"), null));
                    ps.setString(22, asText(test.get("osPlatform"), null));
                    ps.setString(23, asText(test.get("osArch"), null));
                    ps.setString(24, safeJsonArray(test.get("tags")));
                    ps.setString(25, safeJsonArray(test.get("steps")));
                    ps.setTimestamp(26, Timestamp.from(completedAt));
                    ps.addBatch();
                }
                ps.executeBatch();
            }
            c.commit();
            return Map.of("runId", runId.toString());
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static TesboArtifactStorageService.ArtifactReadResult getCaseArtifact(UUID projectId, UUID userId, UUID caseId, String kind) {
        RbacService.requireProjectRole(userId, projectId);
        String sql = """
            SELECT trace_url, screenshot_url, video_url, trace_storage_key, screenshot_storage_key, video_storage_key
            FROM tesbo_report_cases
            WHERE id = ? AND project_id = ?
            """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, caseId);
            ps.setObject(2, projectId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) {
                throw new io.javalin.http.NotFoundResponse("Artifact not found");
            }
            String normalized = normalizeArtifactKind(kind);
            return switch (normalized) {
                case "trace" -> TesboArtifactStorageService.read(rs.getString("trace_storage_key"), rs.getString("trace_url"), "application/zip");
                case "screenshot" -> TesboArtifactStorageService.read(rs.getString("screenshot_storage_key"), rs.getString("screenshot_url"), "image/png");
                case "video" -> TesboArtifactStorageService.read(rs.getString("video_storage_key"), rs.getString("video_url"), "video/webm");
                default -> null;
            };
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static Map<String, Object> uploadCaseArtifact(
        UUID projectId,
        UUID userId,
        UUID runId,
        UUID caseId,
        String kind,
        String fileName,
        String contentType,
        byte[] bytes
    ) {
        if (!RbacService.requireProjectRole(userId, projectId).canExportImport()) {
            throw new io.javalin.http.ForbiddenResponse("Cannot upload Tesbo artifacts");
        }
        return uploadCaseArtifactInternal(projectId, runId, caseId, kind, fileName, contentType, bytes);
    }

    public static Map<String, Object> uploadCaseArtifactWithIngestionKey(
        UUID projectId,
        String ingestionKey,
        UUID runId,
        UUID caseId,
        String kind,
        String fileName,
        String contentType,
        byte[] bytes
    ) {
        requireValidIngestionKey(projectId, ingestionKey);
        return uploadCaseArtifactInternal(projectId, runId, caseId, kind, fileName, contentType, bytes);
    }

    public static Map<String, Object> uploadCaseArtifactWithIngestionKey(
        String ingestionKey,
        UUID runId,
        UUID caseId,
        String kind,
        String fileName,
        String contentType,
        byte[] bytes
    ) {
        UUID projectId = resolveProjectIdByIngestionKey(ingestionKey);
        return uploadCaseArtifactInternal(projectId, runId, caseId, kind, fileName, contentType, bytes);
    }

    private static Map<String, Object> uploadCaseArtifactInternal(
        UUID projectId,
        UUID runId,
        UUID caseId,
        String kind,
        String fileName,
        String contentType,
        byte[] bytes
    ) {
        String normalizedKind = normalizeArtifactKind(kind);
        if (normalizedKind.isBlank()) {
            throw new io.javalin.http.BadRequestResponse("Invalid artifact kind");
        }
        if (bytes == null || bytes.length == 0) {
            throw new io.javalin.http.BadRequestResponse("file is required");
        }
        String effectiveContentType = asText(contentType, "application/octet-stream");
        String ext = extensionFromFileName(fileName, normalizedKind, effectiveContentType);
        String key = "projects/" + projectId + "/runs/" + runId + "/cases/" + caseId + "/" + normalizedKind + "." + ext;
        TesboArtifactStorageService.ArtifactLocation location = TesboArtifactStorageService.store(key, bytes, effectiveContentType);

        String sql = """
            UPDATE tesbo_report_cases
            SET %s = ?
            WHERE id = ? AND run_id = ? AND project_id = ?
            """.formatted(storageColumn(normalizedKind));
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, location.storageKey());
            ps.setObject(2, caseId);
            ps.setObject(3, runId);
            ps.setObject(4, projectId);
            int updated = ps.executeUpdate();
            if (updated == 0) throw new io.javalin.http.NotFoundResponse("Case not found");
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }

        return Map.of(
            "caseId", caseId.toString(),
            "kind", normalizedKind,
            "url", "/api/projects/" + projectId + "/tesbo-reports/cases/" + caseId + "/artifacts/" + normalizedKind
        );
    }

    public static Map<String, Object> ingestPlaywrightFile(UUID projectId, UUID userId, byte[] fileBytes) {
        if (fileBytes == null || fileBytes.length == 0) {
            throw new io.javalin.http.BadRequestResponse("result file is required");
        }
        try {
            Map<String, Object> parsed = JSON.readValue(fileBytes, new TypeReference<Map<String, Object>>() {});
            return ingestPlaywright(projectId, userId, parsed == null ? Map.of() : parsed);
        } catch (Exception e) {
            throw new io.javalin.http.BadRequestResponse("Invalid JSON result file");
        }
    }

    public static Map<String, Object> ingestPlaywrightFileWithIngestionKey(UUID projectId, String ingestionKey, byte[] fileBytes) {
        if (fileBytes == null || fileBytes.length == 0) {
            throw new io.javalin.http.BadRequestResponse("result file is required");
        }
        try {
            Map<String, Object> parsed = JSON.readValue(fileBytes, new TypeReference<Map<String, Object>>() {});
            return ingestPlaywrightWithIngestionKey(projectId, ingestionKey, parsed == null ? Map.of() : parsed);
        } catch (Exception e) {
            throw new io.javalin.http.BadRequestResponse("Invalid JSON result file");
        }
    }

    public static Map<String, Object> ingestPlaywrightFileWithIngestionKey(String ingestionKey, byte[] fileBytes) {
        if (fileBytes == null || fileBytes.length == 0) {
            throw new io.javalin.http.BadRequestResponse("result file is required");
        }
        try {
            Map<String, Object> parsed = JSON.readValue(fileBytes, new TypeReference<Map<String, Object>>() {});
            return ingestPlaywrightWithIngestionKey(ingestionKey, parsed == null ? Map.of() : parsed);
        } catch (Exception e) {
            throw new io.javalin.http.BadRequestResponse("Invalid JSON result file");
        }
    }

    public static Map<String, Object> resolveProjectByIngestionKey(String ingestionKey) {
        UUID projectId = resolveProjectIdByIngestionKey(ingestionKey);
        return Map.of("projectId", projectId.toString());
    }

    private static Map<String, Object> mapRunRow(ResultSet rs) throws SQLException {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", rs.getObject("id").toString());
        row.put("projectId", rs.getObject("project_id").toString());
        row.put("name", rs.getString("name"));
        row.put("status", rs.getString("status"));
        Timestamp started = rs.getTimestamp("started_at");
        Timestamp ended = rs.getTimestamp("ended_at");
        row.put("startedAt", started != null ? started.toInstant().toString() : null);
        row.put("endedAt", ended != null ? ended.toInstant().toString() : null);
        row.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
        row.put("branchName", rs.getString("branch_name"));
        row.put("pullRequest", rs.getString("pull_request"));
        row.put("commitAuthor", rs.getString("commit_author"));
        row.put("runNumber", rs.getString("run_number"));
        row.put("sourceType", rs.getString("source_type"));
        row.put("githubRunId", rs.getString("github_run_id"));
        row.put("total", rs.getInt("total"));
        row.put("passed", rs.getInt("passed"));
        row.put("failed", rs.getInt("failed"));
        row.put("skipped", rs.getInt("skipped"));
        return row;
    }

    private static String buildArtifactUrl(UUID projectId, String caseId, String kind, String storageKey, String fallbackUrl) {
        if (storageKey != null && !storageKey.isBlank()) {
            String directUrl = TesboArtifactStorageService.resolveDirectUrlIfAvailable(storageKey);
            if (directUrl != null && !directUrl.isBlank()) {
                return directUrl;
            }
            return "/api/projects/" + projectId + "/tesbo-reports/cases/" + caseId + "/artifacts/" + kind;
        }
        return fallbackUrl;
    }

    private static String normalizeArtifactKind(String kind) {
        String value = asText(kind, "").trim().toLowerCase();
        return switch (value) {
            case "trace", "screenshot", "video" -> value;
            default -> "";
        };
    }

    private static TesboArtifactStorageService.ArtifactLocation saveArtifact(
        UUID projectId,
        UUID runId,
        UUID caseId,
        String kind,
        String contentType,
        byte[] payload
    ) {
        if (payload == null || payload.length == 0) {
            return null;
        }
        String ext = TesboArtifactStorageService.extensionFor(kind, contentType);
        String key = "projects/" + projectId + "/runs/" + runId + "/cases/" + caseId + "/" + kind + "." + ext;
        return TesboArtifactStorageService.store(key, payload, contentType);
    }

    private static String storageColumn(String normalizedKind) {
        return switch (normalizedKind) {
            case "trace" -> "trace_storage_key";
            case "screenshot" -> "screenshot_storage_key";
            case "video" -> "video_storage_key";
            default -> throw new io.javalin.http.BadRequestResponse("Invalid artifact kind");
        };
    }

    private static String extensionFromFileName(String fileName, String kind, String contentType) {
        if (fileName != null) {
            int idx = fileName.lastIndexOf('.');
            if (idx > -1 && idx + 1 < fileName.length()) {
                String ext = fileName.substring(idx + 1).trim().toLowerCase();
                if (!ext.isBlank() && ext.length() <= 8) return ext;
            }
        }
        return TesboArtifactStorageService.extensionFor(kind, contentType);
    }

    private static List<Map<String, Object>> listRunCasesForShare(Connection c, UUID runId, String token) throws SQLException {
        String sql = """
            SELECT id, spec_name, test_name, full_title, status, duration_ms, trace_url, screenshot_url, video_url,
                   trace_storage_key, screenshot_storage_key, video_storage_key
                   ,error_message, attempt, tags_json
            FROM tesbo_report_cases
            WHERE run_id = ?
            ORDER BY executed_at DESC NULLS LAST, test_name
            """;
        List<Map<String, Object>> out = new ArrayList<>();
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, runId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                Map<String, Object> row = new LinkedHashMap<>();
                String caseId = rs.getObject("id").toString();
                row.put("caseId", caseId);
                row.put("specName", rs.getString("spec_name"));
                row.put("title", rs.getString("test_name"));
                row.put("fullTitle", rs.getString("full_title"));
                row.put("status", rs.getString("status"));
                row.put("durationMs", rs.getObject("duration_ms") == null ? null : rs.getInt("duration_ms"));
                row.put("errorMessage", rs.getString("error_message"));
                row.put("attempt", rs.getObject("attempt") == null ? null : rs.getInt("attempt"));
                row.put("tags", parseStringList(rs.getString("tags_json")));
                row.put("traceUrl", buildPublicArtifactUrl(token, caseId, "trace", rs.getString("trace_storage_key"), rs.getString("trace_url")));
                row.put("screenshotUrl", buildPublicArtifactUrl(token, caseId, "screenshot", rs.getString("screenshot_storage_key"), rs.getString("screenshot_url")));
                row.put("videoUrl", buildPublicArtifactUrl(token, caseId, "video", rs.getString("video_storage_key"), rs.getString("video_url")));
                out.add(row);
            }
        }
        return out;
    }

    private static String buildPublicArtifactUrl(String token, String caseId, String kind, String storageKey, String fallbackUrl) {
        if (storageKey != null && !storageKey.isBlank()) {
            String directUrl = TesboArtifactStorageService.resolveDirectUrlIfAvailable(storageKey);
            if (directUrl != null && !directUrl.isBlank()) {
                return directUrl;
            }
            return "/api/public/tesbo-reports/" + token + "/cases/" + caseId + "/artifacts/" + kind;
        }
        return fallbackUrl;
    }

    private static Map<String, Object> mapAlertRow(ResultSet rs) throws SQLException {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", rs.getObject("id").toString());
        row.put("name", rs.getString("name"));
        row.put("conditionType", rs.getString("condition_type"));
        row.put("comparator", rs.getString("comparator"));
        row.put("threshold", rs.getObject("threshold"));
        row.put("recipients", parseRecipients(rs.getString("recipients_json")));
        row.put("frequency", rs.getString("frequency"));
        row.put("enabled", rs.getBoolean("enabled"));
        row.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
        row.put("updatedAt", rs.getTimestamp("updated_at").toInstant().toString());
        return row;
    }

    private static List<String> parseRecipients(String recipientsJson) {
        if (recipientsJson == null || recipientsJson.isBlank()) return List.of();
        try {
            return JSON.readValue(recipientsJson, new TypeReference<List<String>>() {});
        } catch (Exception ignored) {
            return List.of();
        }
    }

    private static List<String> parseStringList(String rawJson) {
        if (rawJson == null || rawJson.isBlank()) return List.of();
        try {
            return JSON.readValue(rawJson, new TypeReference<List<String>>() {});
        } catch (Exception ignored) {
            return List.of();
        }
    }

    private static List<Map<String, Object>> parseSteps(String rawJson) {
        if (rawJson == null || rawJson.isBlank()) return List.of();
        try {
            return JSON.readValue(rawJson, new TypeReference<List<Map<String, Object>>>() {});
        } catch (Exception ignored) {
            return List.of();
        }
    }

    private static String safeJsonArray(Object value) {
        try {
            if (value == null) return "[]";
            if (value instanceof List<?>) return JSON.writeValueAsString(value);
            return "[]";
        } catch (Exception e) {
            return "[]";
        }
    }

    private static String recipientsJson(Object recipients) {
        try {
            if (recipients == null) return "[]";
            return JSON.writeValueAsString(recipients);
        } catch (Exception e) {
            return "[]";
        }
    }

    private static int queryCount(Connection c, String sql, UUID projectId) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ResultSet rs = ps.executeQuery();
            return rs.next() ? rs.getInt(1) : 0;
        }
    }

    private static String generateToken() {
        byte[] bytes = new byte[24];
        new SecureRandom().nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static void requireValidIngestionKey(UUID projectId, String candidateKey) {
        UUID resolved = resolveProjectIdByIngestionKey(candidateKey);
        if (!resolved.equals(projectId)) {
            throw new io.javalin.http.UnauthorizedResponse("Invalid project access key");
        }
    }

    private static UUID resolveProjectIdByIngestionKey(String candidateKey) {
        String trimmed = asText(candidateKey, "").trim();
        if (trimmed.isBlank()) {
            throw new io.javalin.http.UnauthorizedResponse("Project access key is required");
        }

        String sql = """
            SELECT id
            FROM projects
            WHERE settings -> 'tesboReports' ->> 'ingestionApiKey' = ?
            LIMIT 2
            """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, trimmed);
            ResultSet rs = ps.executeQuery();
            List<UUID> matches = new ArrayList<>();
            while (rs.next()) {
                matches.add((UUID) rs.getObject("id"));
            }
            if (matches.isEmpty()) {
                throw new io.javalin.http.UnauthorizedResponse("Invalid project access key");
            }
            if (matches.size() > 1) {
                throw new io.javalin.http.UnauthorizedResponse("Project access key is not unique");
            }
            return matches.get(0);
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static Map<String, Object> readProjectSettings(UUID projectId) {
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("SELECT settings FROM projects WHERE id = ?")) {
            ps.setObject(1, projectId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) throw new io.javalin.http.NotFoundResponse("Project not found");
            String raw = rs.getString("settings");
            if (raw == null || raw.isBlank()) return new HashMap<>();
            return JSON.readValue(raw, new TypeReference<Map<String, Object>>() {});
        } catch (io.javalin.http.HttpResponseException e) {
            throw e;
        } catch (Exception e) {
            return new HashMap<>();
        }
    }

    private static void writeProjectSettings(UUID projectId, Map<String, Object> settings) {
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("UPDATE projects SET settings = ?::jsonb, updated_at = now() WHERE id = ?")) {
            ps.setString(1, JSON.writeValueAsString(settings));
            ps.setObject(2, projectId);
            ps.executeUpdate();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object obj) {
        if (obj instanceof Map<?, ?> m) return (Map<String, Object>) m;
        return new HashMap<>();
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> castListOfMaps(Object value) {
        if (!(value instanceof List<?> list)) return List.of();
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object item : list) {
            if (item instanceof Map<?, ?>) out.add((Map<String, Object>) item);
        }
        return out;
    }

    private static String asText(Object value, String fallback) {
        if (value == null) return fallback;
        String str = String.valueOf(value);
        return str.isBlank() ? fallback : str;
    }

    private static Integer asNullableInt(Object value) {
        if (value == null) return null;
        if (value instanceof Number n) return n.intValue();
        try {
            return Integer.parseInt(String.valueOf(value));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static boolean asBoolean(Object value, boolean fallback) {
        if (value == null) return fallback;
        if (value instanceof Boolean b) return b;
        return "true".equalsIgnoreCase(String.valueOf(value));
    }

    private static Instant parseInstant(Object value, Instant fallback) {
        if (value == null) return fallback;
        try {
            return Instant.parse(String.valueOf(value));
        } catch (Exception ignored) {
            return fallback;
        }
    }

    private static Optional<UUID> parseUuid(Object value) {
        if (value == null) return Optional.empty();
        try {
            return Optional.of(UUID.fromString(String.valueOf(value)));
        } catch (Exception ignored) {
            return Optional.empty();
        }
    }
}
