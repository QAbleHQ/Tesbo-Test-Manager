package com.bettercases.bug;

import com.bettercases.Database;
import com.bettercases.rbac.RbacService;

import java.sql.*;
import java.util.*;

public final class BugService {

    /* ───── LIST bugs for a project ───── */
    public static List<Map<String, Object>> list(UUID projectId, UUID userId, String status, UUID cycleId) {
        RbacService.requireProjectRole(userId, projectId);
        StringBuilder sql = new StringBuilder("""
            SELECT b.id, b.title, b.description, b.external_url, b.status,
                   b.execution_id, b.testcase_id, b.cycle_id,
                   b.reported_by, b.created_at, b.updated_at,
                   u.name AS reporter_name, u.email AS reporter_email,
                   tc.external_id AS tc_external_id, tc.title AS tc_title,
                   c.name AS cycle_name
            FROM bugs b
            LEFT JOIN users u ON u.id = b.reported_by
            LEFT JOIN testcases tc ON tc.id = b.testcase_id
            LEFT JOIN cycles c ON c.id = b.cycle_id
            WHERE b.project_id = ?
            """);
        List<Object> params = new ArrayList<>();
        params.add(projectId);
        if (status != null && !status.isBlank()) {
            sql.append(" AND b.status = ?");
            params.add(status);
        }
        if (cycleId != null) {
            sql.append(" AND b.cycle_id = ?");
            params.add(cycleId);
        }
        sql.append(" ORDER BY b.created_at DESC");

        List<Map<String, Object>> out = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql.toString())) {
            for (int i = 0; i < params.size(); i++) {
                ps.setObject(i + 1, params.get(i));
            }
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                out.add(mapRow(rs));
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return out;
    }

    /* ───── GET single bug ───── */
    public static Optional<Map<String, Object>> get(UUID bugId, UUID userId) {
        String sql = """
            SELECT b.id, b.title, b.description, b.external_url, b.status,
                   b.execution_id, b.testcase_id, b.cycle_id, b.project_id,
                   b.reported_by, b.created_at, b.updated_at,
                   u.name AS reporter_name, u.email AS reporter_email,
                   tc.external_id AS tc_external_id, tc.title AS tc_title,
                   c.name AS cycle_name
            FROM bugs b
            LEFT JOIN users u ON u.id = b.reported_by
            LEFT JOIN testcases tc ON tc.id = b.testcase_id
            LEFT JOIN cycles c ON c.id = b.cycle_id
            WHERE b.id = ?
            """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, bugId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) {
                UUID projectId = (UUID) rs.getObject("project_id");
                RbacService.requireProjectRole(userId, projectId);
                return Optional.of(mapRow(rs));
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return Optional.empty();
    }

    /* ───── CREATE a bug ───── */
    public static Map<String, Object> create(UUID projectId, UUID userId, String title, String description,
                                             String externalUrl, UUID executionId, UUID testcaseId, UUID cycleId) {
        RbacService.requireProjectRole(userId, projectId);
        String sql = """
            INSERT INTO bugs (project_id, title, description, external_url, execution_id, testcase_id, cycle_id, reported_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id, created_at
            """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ps.setString(2, title);
            ps.setString(3, description != null ? description : "");
            ps.setString(4, externalUrl != null ? externalUrl : "");
            ps.setObject(5, executionId);
            ps.setObject(6, testcaseId);
            ps.setObject(7, cycleId);
            ps.setObject(8, userId);
            ResultSet rs = ps.executeQuery();
            rs.next();
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", rs.getObject("id").toString());
            m.put("title", title);
            m.put("status", "Open");
            m.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
            return m;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    /* ───── UPDATE a bug ───── */
    public static void update(UUID bugId, UUID userId, String title, String description,
                              String externalUrl, String status) {
        UUID projectId = getProjectId(bugId);
        RbacService.requireProjectRole(userId, projectId);
        String sql = """
            UPDATE bugs SET
              title = COALESCE(?, title),
              description = COALESCE(?, description),
              external_url = COALESCE(?, external_url),
              status = COALESCE(?, status),
              updated_at = now()
            WHERE id = ?
            """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, title);
            ps.setString(2, description);
            ps.setString(3, externalUrl);
            ps.setString(4, status);
            ps.setObject(5, bugId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    /* ───── DELETE a bug ───── */
    public static void delete(UUID bugId, UUID userId) {
        UUID projectId = getProjectId(bugId);
        RbacService.requireProjectRole(userId, projectId);
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("DELETE FROM bugs WHERE id = ?")) {
            ps.setObject(1, bugId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    /* ───── helpers ───── */
    private static Map<String, Object> mapRow(ResultSet rs) throws SQLException {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", rs.getObject("id").toString());
        m.put("title", rs.getString("title"));
        m.put("description", rs.getString("description") != null ? rs.getString("description") : "");
        m.put("externalUrl", rs.getString("external_url") != null ? rs.getString("external_url") : "");
        m.put("status", rs.getString("status"));
        Object execId = rs.getObject("execution_id");
        m.put("executionId", execId != null ? execId.toString() : null);
        Object tcId = rs.getObject("testcase_id");
        m.put("testcaseId", tcId != null ? tcId.toString() : null);
        Object cyId = rs.getObject("cycle_id");
        m.put("cycleId", cyId != null ? cyId.toString() : null);
        Object reportedBy = rs.getObject("reported_by");
        m.put("reportedBy", reportedBy != null ? reportedBy.toString() : null);
        m.put("reporterName", rs.getString("reporter_name") != null ? rs.getString("reporter_name") : "");
        m.put("reporterEmail", rs.getString("reporter_email") != null ? rs.getString("reporter_email") : "");
        m.put("tcExternalId", rs.getString("tc_external_id") != null ? rs.getString("tc_external_id") : "");
        m.put("tcTitle", rs.getString("tc_title") != null ? rs.getString("tc_title") : "");
        m.put("cycleName", rs.getString("cycle_name") != null ? rs.getString("cycle_name") : "");
        m.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
        m.put("updatedAt", rs.getTimestamp("updated_at").toInstant().toString());
        return m;
    }

    private static UUID getProjectId(UUID bugId) {
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("SELECT project_id FROM bugs WHERE id = ?")) {
            ps.setObject(1, bugId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) return (UUID) rs.getObject("project_id");
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        throw new io.javalin.http.NotFoundResponse();
    }
}
