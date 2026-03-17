package com.bettercases.suite;

import com.bettercases.Database;
import com.bettercases.rbac.RbacService;

import java.sql.*;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class SuiteService {
    private static final String DEFAULT_SUITE_NAME = "Default Suite";

    public static List<Map<String, Object>> listTree(UUID projectId, UUID userId) {
        RbacService.requireProjectRole(userId, projectId);
        ensureDefaultSuiteExists(projectId);
        String sql = "SELECT s.id, s.parent_id, s.name, s.position, s.created_at, COALESCE(tc.cnt, 0) AS test_case_count FROM suites s LEFT JOIN (SELECT suite_id, COUNT(*) AS cnt FROM testcases GROUP BY suite_id) tc ON tc.suite_id = s.id WHERE s.project_id = ? ORDER BY s.parent_id NULLS FIRST, s.position, s.name";
        List<Map<String, Object>> rows = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                Object parentId = rs.getObject("parent_id");
                Map<String, Object> row = new HashMap<>();
                row.put("id", rs.getObject("id").toString());
                row.put("parentId", parentId != null ? parentId.toString() : null);
                row.put("name", rs.getString("name"));
                row.put("position", rs.getInt("position"));
                row.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
                row.put("testCaseCount", rs.getInt("test_case_count"));
                rows.add(row);
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return rows;
    }

    public static void ensureDefaultSuiteExists(UUID projectId) {
        String countSql = "SELECT COUNT(*) FROM suites WHERE project_id = ?";
        String insertSql = "INSERT INTO suites (project_id, parent_id, name, position) VALUES (?, NULL, ?, 0)";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement countPs = c.prepareStatement(countSql)) {
            countPs.setObject(1, projectId);
            ResultSet rs = countPs.executeQuery();
            rs.next();
            if (rs.getLong(1) > 0) return;
            try (PreparedStatement insertPs = c.prepareStatement(insertSql)) {
                insertPs.setObject(1, projectId);
                insertPs.setString(2, DEFAULT_SUITE_NAME);
                insertPs.executeUpdate();
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static Map<String, Object> create(UUID projectId, UUID userId, String name, UUID parentId, int position) {
        RbacService.requireProjectRole(userId, projectId);
        String sql = "INSERT INTO suites (project_id, parent_id, name, position) VALUES (?, ?, ?, ?) RETURNING id, parent_id, name, position, created_at";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ps.setObject(2, null);
            ps.setString(3, name);
            ps.setInt(4, position);
            ResultSet rs = ps.executeQuery();
            rs.next();
            Object pId = rs.getObject("parent_id");
            Map<String, Object> row = new HashMap<>();
            row.put("id", rs.getObject("id").toString());
            row.put("parentId", pId != null ? pId.toString() : null);
            row.put("name", rs.getString("name"));
            row.put("position", rs.getInt("position"));
            row.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
            return row;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static void update(UUID suiteId, UUID userId, String name, UUID parentId, Integer position) {
        UUID projectId = getProjectId(suiteId);
        RbacService.requireProjectRole(userId, projectId);
        if (name != null) {
            try (Connection c = Database.getDataSource().getConnection();
                 PreparedStatement ps = c.prepareStatement("UPDATE suites SET name = ?, updated_at = now() WHERE id = ?")) {
                ps.setString(1, name);
                ps.setObject(2, suiteId);
                ps.executeUpdate();
            } catch (SQLException e) {
                throw new RuntimeException(e);
            }
        }
        if (position != null) {
            try (Connection c = Database.getDataSource().getConnection();
                 PreparedStatement ps = c.prepareStatement("UPDATE suites SET position = ?, updated_at = now() WHERE id = ?")) {
                ps.setInt(1, position);
                ps.setObject(2, suiteId);
                ps.executeUpdate();
            } catch (SQLException e) {
                throw new RuntimeException(e);
            }
        }
    }

    public static void delete(UUID suiteId, UUID userId, String mode) {
        UUID projectId = getProjectId(suiteId);
        RbacService.requireProjectRole(userId, projectId);
        try (Connection c = Database.getDataSource().getConnection()) {
            c.setAutoCommit(false);
            try {
                if ("deleteTestcases".equals(mode)) {
                    try (PreparedStatement ps = c.prepareStatement(
                            "DELETE FROM testcases WHERE suite_id = ?")) {
                        ps.setObject(1, suiteId);
                        ps.executeUpdate();
                    }
                } else {
                    UUID defaultSuiteId = getOrCreateDefaultSuite(c, projectId, suiteId);
                    try (PreparedStatement ps = c.prepareStatement(
                            "UPDATE testcases SET suite_id = ? WHERE suite_id = ?")) {
                        ps.setObject(1, defaultSuiteId);
                        ps.setObject(2, suiteId);
                        ps.executeUpdate();
                    }
                }
                try (PreparedStatement ps = c.prepareStatement(
                        "DELETE FROM suites WHERE id = ?")) {
                    ps.setObject(1, suiteId);
                    ps.executeUpdate();
                }
                c.commit();
            } catch (SQLException e) {
                c.rollback();
                throw e;
            } finally {
                c.setAutoCommit(true);
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static UUID getOrCreateDefaultSuite(Connection c, UUID projectId, UUID excludeSuiteId) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement(
                "SELECT id FROM suites WHERE project_id = ? AND name = ? AND id != ? LIMIT 1")) {
            ps.setObject(1, projectId);
            ps.setString(2, DEFAULT_SUITE_NAME);
            ps.setObject(3, excludeSuiteId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) return (UUID) rs.getObject("id");
        }
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO suites (id, project_id, parent_id, name, position) VALUES (gen_random_uuid(), ?, NULL, ?, 0) RETURNING id")) {
            ps.setObject(1, projectId);
            ps.setString(2, DEFAULT_SUITE_NAME);
            ResultSet rs = ps.executeQuery();
            rs.next();
            return (UUID) rs.getObject("id");
        }
    }

    public static UUID getProjectIdForSuite(UUID suiteId) {
        return getProjectId(suiteId);
    }

    private static UUID getProjectId(UUID suiteId) {
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("SELECT project_id FROM suites WHERE id = ?")) {
            ps.setObject(1, suiteId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) return (UUID) rs.getObject("project_id");
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        throw new io.javalin.http.NotFoundResponse();
    }
}
