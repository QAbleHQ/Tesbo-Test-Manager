package com.bettercases.testcase;

import com.bettercases.Database;
import com.bettercases.rbac.RbacService;
import org.postgresql.util.PGobject;

import java.sql.*;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

public final class TestCaseService {
    public static List<Map<String, Object>> list(UUID projectId, UUID userId, int limit, int offset,
                                                   String suiteId, String status, String priority, String type, String automationStatus, String search) {
        RbacService.requireProjectRole(userId, projectId);
        StringBuilder sql = new StringBuilder(
                "SELECT tc.id, tc.external_id, tc.title, tc.priority, tc.type, tc.automation_status, tc.automation_tags, tc.status, tc.suite_id, tc.owner_id, tc.updated_at, tc.jira_issue_key, tc.jira_url " +
                        "FROM testcases tc WHERE tc.project_id = ?");
        List<Object> params = new ArrayList<>();
        params.add(projectId);
        if (suiteId != null && !suiteId.isBlank()) {
            sql.append(" AND tc.suite_id = ?");
            params.add(UUID.fromString(suiteId));
        }
        if (status != null && !status.isBlank()) {
            sql.append(" AND tc.status = ?");
            params.add(status);
        }
        if (priority != null && !priority.isBlank()) {
            sql.append(" AND tc.priority = ?");
            params.add(priority);
        }
        if (type != null && !type.isBlank()) {
            sql.append(" AND tc.type = ?");
            params.add(type);
        }
        if (automationStatus != null && !automationStatus.isBlank()) {
            sql.append(" AND tc.automation_status = ?");
            params.add(automationStatus);
        }
        if (search != null && !search.isBlank()) {
            sql.append(" AND tc.search_vector @@ plainto_tsquery('english', ?)");
            params.add(search);
        }
        sql.append(" ORDER BY tc.updated_at DESC LIMIT ? OFFSET ?");
        params.add(limit);
        params.add(offset);

        List<Map<String, Object>> out = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql.toString())) {
            for (int i = 0; i < params.size(); i++) ps.setObject(i + 1, params.get(i));
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                Object suiteIdObj = rs.getObject("suite_id");
                Object ownerIdObj = rs.getObject("owner_id");
                Map<String, Object> row = new HashMap<>();
                row.put("id", rs.getObject("id").toString());
                row.put("externalId", rs.getString("external_id"));
                row.put("title", rs.getString("title"));
                row.put("priority", rs.getString("priority"));
                row.put("type", rs.getString("type") != null ? rs.getString("type") : "Functional");
                row.put("automationStatus", rs.getString("automation_status") != null ? rs.getString("automation_status") : "Not Automated");
                row.put("automationTags", rs.getString("automation_tags") != null ? rs.getString("automation_tags") : "");
                row.put("status", rs.getString("status"));
                row.put("suiteId", suiteIdObj != null ? suiteIdObj.toString() : null);
                row.put("ownerId", ownerIdObj != null ? ownerIdObj.toString() : null);
                row.put("updatedAt", rs.getTimestamp("updated_at").toInstant().toString());
                row.put("jiraIssueKey", rs.getString("jira_issue_key"));
                row.put("jiraUrl", rs.getString("jira_url"));
                out.add(row);
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return out;
    }

    public static long count(UUID projectId, UUID userId, String suiteId, String status, String priority, String type, String automationStatus, String search) {
        RbacService.requireProjectRole(userId, projectId);
        StringBuilder sql = new StringBuilder("SELECT COUNT(*) FROM testcases tc WHERE tc.project_id = ?");
        List<Object> params = new ArrayList<>();
        params.add(projectId);
        if (suiteId != null && !suiteId.isBlank()) {
            sql.append(" AND tc.suite_id = ?");
            params.add(UUID.fromString(suiteId));
        }
        if (status != null && !status.isBlank()) { sql.append(" AND tc.status = ?"); params.add(status); }
        if (priority != null && !priority.isBlank()) { sql.append(" AND tc.priority = ?"); params.add(priority); }
        if (type != null && !type.isBlank()) { sql.append(" AND tc.type = ?"); params.add(type); }
        if (automationStatus != null && !automationStatus.isBlank()) { sql.append(" AND tc.automation_status = ?"); params.add(automationStatus); }
        if (search != null && !search.isBlank()) { sql.append(" AND tc.search_vector @@ plainto_tsquery('english', ?)"); params.add(search); }
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql.toString())) {
            for (int i = 0; i < params.size(); i++) ps.setObject(i + 1, params.get(i));
            ResultSet rs = ps.executeQuery();
            rs.next();
            return rs.getLong(1);
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static Optional<Map<String, Object>> get(UUID testcaseId, UUID userId) {
        UUID projectId = getProjectId(testcaseId);
        RbacService.requireProjectRole(userId, projectId);
        String sql = "SELECT id, project_id, suite_id, external_id, title, description, preconditions, postconditions, steps, test_data, estimated_duration, attachments, " +
                "priority, severity, type, automation_status, automation_repo, automation_path, automation_test_name, automation_framework, automation_tags, " +
                "automation_script, automation_script_language, automation_script_version, automated_at, automated_by, " +
                "owner_id, component, status, created_at, updated_at, jira_issue_key, jira_url FROM testcases WHERE id = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, testcaseId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) {
                Object suiteId = rs.getObject("suite_id");
                Object ownerId = rs.getObject("owner_id");
                Map<String, Object> m = new HashMap<>();
                m.put("id", rs.getObject("id").toString());
                m.put("projectId", rs.getObject("project_id").toString());
                m.put("suiteId", suiteId != null ? suiteId.toString() : null);
                m.put("externalId", rs.getString("external_id"));
                m.put("title", rs.getString("title"));
                m.put("description", rs.getString("description") != null ? rs.getString("description") : "");
                m.put("preconditions", rs.getString("preconditions") != null ? rs.getString("preconditions") : "");
                m.put("postconditions", rs.getString("postconditions") != null ? rs.getString("postconditions") : "");
                m.put("steps", rs.getString("steps") != null ? rs.getString("steps") : "[]");
                m.put("testData", rs.getString("test_data") != null ? rs.getString("test_data") : "");
                m.put("estimatedDuration", rs.getString("estimated_duration") != null ? rs.getString("estimated_duration") : "");
                m.put("attachments", rs.getString("attachments") != null ? rs.getString("attachments") : "");
                m.put("priority", rs.getString("priority"));
                m.put("severity", rs.getString("severity") != null ? rs.getString("severity") : "");
                m.put("type", rs.getString("type") != null ? rs.getString("type") : "Functional");
                m.put("automationStatus", rs.getString("automation_status") != null ? rs.getString("automation_status") : "Not Automated");
                m.put("automationRepo", rs.getString("automation_repo") != null ? rs.getString("automation_repo") : "");
                m.put("automationPath", rs.getString("automation_path") != null ? rs.getString("automation_path") : "");
                m.put("automationTestName", rs.getString("automation_test_name") != null ? rs.getString("automation_test_name") : "");
                m.put("automationFramework", rs.getString("automation_framework") != null ? rs.getString("automation_framework") : "");
                m.put("automationTags", rs.getString("automation_tags") != null ? rs.getString("automation_tags") : "");
                m.put("automationScript", rs.getString("automation_script") != null ? rs.getString("automation_script") : "");
                m.put("automationScriptLanguage", rs.getString("automation_script_language") != null ? rs.getString("automation_script_language") : "");
                m.put("automationScriptVersion", rs.getInt("automation_script_version"));
                String currentScript = rs.getString("automation_script") != null ? rs.getString("automation_script") : "";
                String currentScriptLanguage = rs.getString("automation_script_language") != null ? rs.getString("automation_script_language") : "";
                int currentScriptVersion = rs.getInt("automation_script_version");
                String testcaseUpdatedAt = rs.getTimestamp("updated_at").toInstant().toString();
                m.put("automationScriptHistory", listAutomationScriptHistory(
                        testcaseId,
                        currentScript,
                        currentScriptLanguage,
                        currentScriptVersion,
                        testcaseUpdatedAt
                ));
                m.put("automatedAt", rs.getTimestamp("automated_at") != null ? rs.getTimestamp("automated_at").toInstant().toString() : null);
                Object automatedBy = rs.getObject("automated_by");
                m.put("automatedBy", automatedBy != null ? automatedBy.toString() : null);
                m.put("ownerId", ownerId != null ? ownerId.toString() : null);
                m.put("component", rs.getString("component") != null ? rs.getString("component") : "");
                m.put("status", rs.getString("status"));
                m.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
                m.put("updatedAt", rs.getTimestamp("updated_at").toInstant().toString());
                m.put("jiraIssueKey", rs.getString("jira_issue_key") != null ? rs.getString("jira_issue_key") : "");
                m.put("jiraUrl", rs.getString("jira_url") != null ? rs.getString("jira_url") : "");
                return Optional.of(m);
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return Optional.empty();
    }

    public static String nextExternalId(UUID projectId) {
        String keyPrefix;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("SELECT key FROM projects WHERE id = ?")) {
            ps.setObject(1, projectId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) throw new IllegalArgumentException("Project not found");
            keyPrefix = rs.getString("key");
            if (keyPrefix.length() > 3) keyPrefix = keyPrefix.substring(0, 3);
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        String likePattern = keyPrefix + "-TC-%";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("SELECT COALESCE(MAX(CAST(SUBSTRING(external_id FROM '[0-9]+$') AS INTEGER)), 0) + 1 AS n FROM testcases WHERE project_id = ? AND external_id LIKE ?")) {
            ps.setObject(1, projectId);
            ps.setString(2, likePattern);
            ResultSet rs = ps.executeQuery();
            rs.next();
            int n = rs.getInt("n");
            return keyPrefix + "-TC-" + String.format("%02d", n);
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static Map<String, Object> create(UUID projectId, UUID userId, CreateDto dto) {
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canEditCases())
            throw new io.javalin.http.ForbiddenResponse("Cannot create test cases");
        String externalId = dto.externalId != null && !dto.externalId.isBlank() ? dto.externalId : nextExternalId(projectId);
        String resolvedAutomationStatus = (dto.automationScript != null && !dto.automationScript.isBlank())
                ? "Automated"
                : (dto.automationStatus != null ? dto.automationStatus : "No");
        String sql = "INSERT INTO testcases (project_id, suite_id, external_id, title, description, preconditions, postconditions, steps, test_data, estimated_duration, attachments, " +
                "priority, severity, type, automation_status, automation_tags, automation_script, automation_script_language, automation_script_version, owner_id, component, status, jira_issue_key, jira_url) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, external_id, title, created_at";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ps.setObject(2, dto.suiteId != null && !dto.suiteId.isBlank() ? UUID.fromString(dto.suiteId) : null);
            ps.setString(3, externalId);
            ps.setString(4, dto.title != null ? dto.title : "Untitled");
            ps.setString(5, dto.description != null ? dto.description : "");
            ps.setString(6, dto.preconditions != null ? dto.preconditions : "");
            ps.setString(7, dto.postconditions != null ? dto.postconditions : "");
            PGobject stepsJson = new PGobject();
            stepsJson.setType("jsonb");
            stepsJson.setValue(dto.steps != null ? dto.steps : "[]");
            ps.setObject(8, stepsJson);
            ps.setString(9, dto.testData != null ? dto.testData : "");
            if (dto.estimatedDuration != null && !dto.estimatedDuration.isBlank()) {
                ps.setString(10, dto.estimatedDuration);
            } else {
                ps.setNull(10, java.sql.Types.VARCHAR);
            }
            if (dto.attachments != null && !dto.attachments.isBlank()) {
                ps.setString(11, dto.attachments);
            } else {
                ps.setNull(11, java.sql.Types.VARCHAR);
            }
            ps.setString(12, dto.priority != null ? dto.priority : "P2");
            if (dto.severity != null && !dto.severity.isBlank()) {
                ps.setString(13, dto.severity);
            } else {
                ps.setNull(13, java.sql.Types.VARCHAR);
            }
            ps.setString(14, dto.type != null ? dto.type : "Functional");
            ps.setString(15, resolvedAutomationStatus);
            if (dto.automationTags != null && !dto.automationTags.isBlank()) {
                ps.setString(16, dto.automationTags);
            } else {
                ps.setNull(16, java.sql.Types.VARCHAR);
            }
            if (dto.automationScript != null) {
                ps.setString(17, dto.automationScript);
            } else {
                ps.setNull(17, java.sql.Types.VARCHAR);
            }
            if (dto.automationScriptLanguage != null && !dto.automationScriptLanguage.isBlank()) {
                ps.setString(18, dto.automationScriptLanguage);
            } else if (dto.automationScript != null && !dto.automationScript.isBlank()) {
                ps.setString(18, "playwright-ts");
            } else {
                ps.setNull(18, java.sql.Types.VARCHAR);
            }
            ps.setInt(19, dto.automationScript != null && !dto.automationScript.isBlank() ? 1 : 0);
            ps.setObject(20, dto.ownerId != null && !dto.ownerId.isBlank() ? UUID.fromString(dto.ownerId) : userId);
            if (dto.component != null && !dto.component.isBlank()) {
                ps.setString(21, dto.component);
            } else {
                ps.setNull(21, java.sql.Types.VARCHAR);
            }
            ps.setString(22, dto.status != null ? dto.status : "Draft");
            if (dto.jiraIssueKey != null && !dto.jiraIssueKey.isBlank()) {
                ps.setString(23, dto.jiraIssueKey);
            } else {
                ps.setNull(23, java.sql.Types.VARCHAR);
            }
            if (dto.jiraUrl != null && !dto.jiraUrl.isBlank()) {
                ps.setString(24, dto.jiraUrl);
            } else {
                ps.setNull(24, java.sql.Types.VARCHAR);
            }
            ResultSet rs = ps.executeQuery();
            rs.next();
            return Map.of(
                    "id", rs.getObject("id").toString(),
                    "externalId", rs.getString("external_id"),
                    "title", rs.getString("title"),
                    "createdAt", rs.getTimestamp("created_at").toInstant().toString()
            );
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static void update(UUID testcaseId, UUID userId, UpdateDto dto) {
        UUID projectId = getProjectId(testcaseId);
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canEditCases())
            throw new io.javalin.http.ForbiddenResponse("Cannot edit test cases");
        try (Connection c = Database.getDataSource().getConnection()) {
            int nextVersion;
            try (PreparedStatement ps = c.prepareStatement("SELECT COALESCE(MAX(version), 0) + 1 FROM testcase_versions WHERE testcase_id = ?")) {
                ps.setObject(1, testcaseId);
                ResultSet rs = ps.executeQuery();
                rs.next();
                nextVersion = rs.getInt(1);
            }
            try (PreparedStatement sel = c.prepareStatement("SELECT title, description, preconditions, postconditions, steps, test_data, estimated_duration, attachments, priority, severity, type, automation_status, automation_repo, automation_path, automation_test_name, automation_framework, automation_tags, automation_script, automation_script_language, automation_script_version, status FROM testcases WHERE id = ?");
                 PreparedStatement ins = c.prepareStatement("INSERT INTO testcase_versions (testcase_id, version, snapshot) SELECT id, ?, jsonb_build_object('title', title, 'description', description, 'preconditions', preconditions, 'postconditions', postconditions, 'steps', steps, 'test_data', test_data, 'estimated_duration', estimated_duration, 'attachments', attachments, 'priority', priority, 'severity', severity, 'type', type, 'automation_status', automation_status, 'automation_repo', automation_repo, 'automation_path', automation_path, 'automation_test_name', automation_test_name, 'automation_framework', automation_framework, 'automation_tags', automation_tags, 'automation_script', automation_script, 'automation_script_language', automation_script_language, 'automation_script_version', automation_script_version, 'status', status) FROM testcases WHERE id = ?")) {
                sel.setObject(1, testcaseId);
                ResultSet rs = sel.executeQuery();
                if (rs.next()) {
                    ins.setInt(1, nextVersion);
                    ins.setObject(2, testcaseId);
                    ins.executeUpdate();
                }
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        String resolvedAutomationStatus = (dto.automationScript != null && !dto.automationScript.isBlank())
                ? "Automated"
                : dto.automationStatus;
        String sql = "UPDATE testcases SET title = COALESCE(?, title), description = COALESCE(?, description), preconditions = COALESCE(?, preconditions), " +
                "postconditions = COALESCE(?, postconditions), steps = COALESCE(?::jsonb, steps), test_data = COALESCE(?, test_data), estimated_duration = ?, attachments = ?, " +
                "priority = COALESCE(?, priority), severity = ?, type = COALESCE(?, type), automation_status = COALESCE(?, automation_status), " +
                "automation_repo = ?, automation_path = ?, automation_test_name = ?, automation_framework = ?, automation_tags = ?, " +
                "automation_script = COALESCE(?, automation_script), automation_script_language = COALESCE(?, automation_script_language), " +
                "automation_script_version = CASE WHEN ? IS NOT NULL THEN COALESCE(automation_script_version, 0) + 1 ELSE automation_script_version END, " +
                "owner_id = CASE WHEN ?::uuid IS NOT NULL THEN ?::uuid ELSE owner_id END, component = COALESCE(?, component), status = COALESCE(?, status), " +
                "suite_id = CASE WHEN ?::uuid IS NOT NULL THEN ?::uuid ELSE suite_id END, updated_at = now() WHERE id = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            String suiteId = dto.suiteId != null && !dto.suiteId.isBlank() ? dto.suiteId : null;
            ps.setString(1, dto.title);
            ps.setString(2, dto.description);
            ps.setString(3, dto.preconditions);
            ps.setString(4, dto.postconditions);
            ps.setString(5, dto.steps);
            ps.setString(6, dto.testData);
            ps.setString(7, dto.estimatedDuration);
            ps.setString(8, dto.attachments);
            ps.setString(9, dto.priority);
            ps.setString(10, dto.severity);
            ps.setString(11, dto.type);
            ps.setString(12, resolvedAutomationStatus);
            ps.setString(13, dto.automationRepo);
            ps.setString(14, dto.automationPath);
            ps.setString(15, dto.automationTestName);
            ps.setString(16, dto.automationFramework);
            ps.setString(17, dto.automationTags);
            ps.setString(18, dto.automationScript);
            ps.setString(19, dto.automationScriptLanguage);
            ps.setString(20, dto.automationScript);
            ps.setString(21, dto.ownerId);
            ps.setString(22, dto.ownerId);
            ps.setString(23, dto.component);
            ps.setString(24, dto.status);
            ps.setString(25, suiteId);
            ps.setString(26, suiteId);
            ps.setObject(27, testcaseId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static void bulkUpdate(UUID projectId, UUID userId, List<UUID> testcaseIds, String priority, String suiteId, String status, String ownerId) {
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canEditCases())
            throw new io.javalin.http.ForbiddenResponse("Cannot bulk update");
        if ((priority == null || priority.isBlank()) && (suiteId == null || suiteId.isBlank()) && (status == null || status.isBlank()) && (ownerId == null || ownerId.isBlank()))
            return;
        for (UUID tcId : testcaseIds) {
            UUID projId = getProjectId(tcId);
            if (!projId.equals(projectId)) continue;
            StringBuilder sql = new StringBuilder("UPDATE testcases SET updated_at = now()");
            List<Object> params = new ArrayList<>();
            if (priority != null && !priority.isBlank()) { sql.append(", priority = ?"); params.add(priority); }
            if (suiteId != null && !suiteId.isBlank()) { sql.append(", suite_id = ?"); params.add(UUID.fromString(suiteId)); }
            if (status != null && !status.isBlank()) { sql.append(", status = ?"); params.add(status); }
            if (ownerId != null && !ownerId.isBlank()) { sql.append(", owner_id = ?"); params.add(UUID.fromString(ownerId)); }
            sql.append(" WHERE id = ?");
            params.add(tcId);
            try (Connection c = Database.getDataSource().getConnection();
                 PreparedStatement ps = c.prepareStatement(sql.toString())) {
                for (int i = 0; i < params.size(); i++) ps.setObject(i + 1, params.get(i));
                ps.executeUpdate();
            } catch (SQLException e) {
                throw new RuntimeException(e);
            }
        }
    }

    public static void delete(UUID testcaseId, UUID userId) {
        UUID projectId = getProjectId(testcaseId);
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canEditCases())
            throw new io.javalin.http.ForbiddenResponse("Cannot delete test cases");
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("DELETE FROM testcases WHERE id = ?")) {
            ps.setObject(1, testcaseId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static void bulkDelete(UUID projectId, UUID userId, List<UUID> testcaseIds) {
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canEditCases())
            throw new io.javalin.http.ForbiddenResponse("Cannot bulk delete");
        for (UUID tcId : testcaseIds) {
            UUID projId = getProjectId(tcId);
            if (!projId.equals(projectId)) continue;
            try (Connection c = Database.getDataSource().getConnection();
                 PreparedStatement ps = c.prepareStatement("DELETE FROM testcases WHERE id = ?")) {
                ps.setObject(1, tcId);
                ps.executeUpdate();
            } catch (SQLException e) {
                throw new RuntimeException(e);
            }
        }
    }

    private static UUID getProjectId(UUID testcaseId) {
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("SELECT project_id FROM testcases WHERE id = ?")) {
            ps.setObject(1, testcaseId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) return (UUID) rs.getObject("project_id");
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        throw new io.javalin.http.NotFoundResponse();
    }

    public static List<String> listLinkedJiraKeys(UUID projectId, UUID userId) {
        RbacService.requireProjectRole(userId, projectId);
        List<String> keys = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(
                     "SELECT DISTINCT jira_issue_key FROM testcases WHERE project_id = ? AND jira_issue_key IS NOT NULL")) {
            ps.setObject(1, projectId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) keys.add(rs.getString("jira_issue_key"));
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return keys;
    }

    public static Map<String, Long> countByJiraKey(UUID projectId, UUID userId) {
        RbacService.requireProjectRole(userId, projectId);
        Map<String, Long> counts = new HashMap<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(
                     "SELECT jira_issue_key, COUNT(*) AS cnt FROM testcases WHERE project_id = ? AND jira_issue_key IS NOT NULL GROUP BY jira_issue_key")) {
            ps.setObject(1, projectId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) counts.put(rs.getString("jira_issue_key"), rs.getLong("cnt"));
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return counts;
    }

    private static List<Map<String, Object>> listAutomationScriptHistory(
            UUID testcaseId,
            String currentScript,
            String currentScriptLanguage,
            int currentScriptVersion,
            String testcaseUpdatedAt
    ) {
        List<Map<String, Object>> history = new ArrayList<>();

        if (currentScript != null && !currentScript.isBlank()) {
            Map<String, Object> current = new HashMap<>();
            current.put("scriptVersion", Math.max(1, currentScriptVersion));
            current.put("testcaseVersion", null);
            current.put("script", currentScript);
            current.put("language", currentScriptLanguage == null ? "" : currentScriptLanguage);
            current.put("capturedAt", testcaseUpdatedAt);
            current.put("isCurrent", true);
            history.add(current);
        }

        String sql = "SELECT version, created_at, " +
                "COALESCE(snapshot->>'automation_script', '') AS script, " +
                "COALESCE(snapshot->>'automation_script_language', '') AS script_language, " +
                "COALESCE(NULLIF(snapshot->>'automation_script_version', '')::int, 0) AS script_version " +
                "FROM testcase_versions WHERE testcase_id = ? ORDER BY created_at DESC";

        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, testcaseId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                String script = rs.getString("script");
                if (script == null || script.isBlank()) continue;
                int scriptVersion = rs.getInt("script_version");
                boolean duplicate = false;
                for (Map<String, Object> entry : history) {
                    Object existingScriptVersion = entry.get("scriptVersion");
                    Object existingScript = entry.get("script");
                    if (existingScriptVersion instanceof Number n &&
                            n.intValue() == scriptVersion &&
                            script.equals(existingScript)) {
                        duplicate = true;
                        break;
                    }
                }
                if (duplicate) continue;

                Map<String, Object> row = new HashMap<>();
                row.put("scriptVersion", scriptVersion);
                row.put("testcaseVersion", rs.getInt("version"));
                row.put("script", script);
                row.put("language", rs.getString("script_language"));
                row.put("capturedAt", rs.getTimestamp("created_at").toInstant().toString());
                row.put("isCurrent", false);
                history.add(row);
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }

        return history;
    }

    public static class CreateDto {
        public String externalId;
        public String suiteId;
        public String title;
        public String description;
        public String preconditions;
        public String postconditions;
        public String steps;
        public String testData;
        public String estimatedDuration;
        public String attachments;
        public String priority;
        public String severity;
        public String type;
        public String automationStatus;
        public String automationTags;
        public String automationScript;
        public String automationScriptLanguage;
        public String ownerId;
        public String component;
        public String status;
        public String jiraIssueKey;
        public String jiraUrl;
    }

    public static class UpdateDto {
        public String title;
        public String description;
        public String preconditions;
        public String postconditions;
        public String steps;
        public String testData;
        public String estimatedDuration;
        public String attachments;
        public String priority;
        public String severity;
        public String type;
        public String automationStatus;
        public String automationRepo;
        public String automationPath;
        public String automationTestName;
        public String automationFramework;
        public String automationTags;
        public String automationScript;
        public String automationScriptLanguage;
        public String ownerId;
        public String component;
        public String status;
        public String suiteId;
    }
}
