package com.bettercases.plan;

import com.bettercases.Database;
import com.bettercases.rbac.RbacService;

import java.sql.*;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

public final class PlanService {
    public static String nextPlanExternalId(UUID projectId) {
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
        String likePattern = keyPrefix + "-TP-%";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("SELECT COALESCE(MAX(CAST(SUBSTRING(external_id FROM '[0-9]+$') AS INTEGER)), 0) + 1 AS n FROM plans WHERE project_id = ? AND external_id LIKE ?")) {
            ps.setObject(1, projectId);
            ps.setString(2, likePattern);
            ResultSet rs = ps.executeQuery();
            rs.next();
            int n = rs.getInt("n");
            return keyPrefix + "-TP-" + String.format("%02d", n);
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static List<Map<String, Object>> list(UUID projectId, UUID userId) {
        RbacService.requireProjectRole(userId, projectId);
        String sql = """
            SELECT p.id, p.external_id, p.name, p.description, p.target_release, p.owner_id, p.created_at,
                   (SELECT COUNT(*) FROM cycles cy WHERE cy.plan_id = p.id) AS run_count,
                   COALESCE((SELECT SUM(sub.total) FROM cycles cy
                     LEFT JOIN LATERAL (
                       SELECT COUNT(*) AS total FROM cycle_items ci JOIN executions e ON e.cycle_item_id = ci.id WHERE ci.cycle_id = cy.id
                     ) sub ON true WHERE cy.plan_id = p.id), 0) AS total_cases,
                   COALESCE((SELECT SUM(sub.passed) FROM cycles cy
                     LEFT JOIN LATERAL (
                       SELECT COUNT(*) FILTER (WHERE e.status = 'Passed') AS passed FROM cycle_items ci JOIN executions e ON e.cycle_item_id = ci.id WHERE ci.cycle_id = cy.id
                     ) sub ON true WHERE cy.plan_id = p.id), 0) AS passed,
                   COALESCE((SELECT SUM(sub.failed) FROM cycles cy
                     LEFT JOIN LATERAL (
                       SELECT COUNT(*) FILTER (WHERE e.status = 'Failed') AS failed FROM cycle_items ci JOIN executions e ON e.cycle_item_id = ci.id WHERE ci.cycle_id = cy.id
                     ) sub ON true WHERE cy.plan_id = p.id), 0) AS failed,
                   COALESCE((SELECT SUM(sub.untested) FROM cycles cy
                     LEFT JOIN LATERAL (
                       SELECT COUNT(*) FILTER (WHERE e.status = 'Untested') AS untested FROM cycle_items ci JOIN executions e ON e.cycle_item_id = ci.id WHERE ci.cycle_id = cy.id
                     ) sub ON true WHERE cy.plan_id = p.id), 0) AS untested
            FROM plans p WHERE p.project_id = ? ORDER BY p.updated_at DESC
            """;
        List<Map<String, Object>> out = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                Object ownerId = rs.getObject("owner_id");
                Map<String, Object> m = new java.util.LinkedHashMap<>();
                m.put("id", rs.getObject("id").toString());
                m.put("externalId", rs.getString("external_id") != null ? rs.getString("external_id") : "");
                m.put("name", rs.getString("name"));
                m.put("description", rs.getString("description") != null ? rs.getString("description") : "");
                m.put("targetRelease", rs.getString("target_release") != null ? rs.getString("target_release") : "");
                m.put("ownerId", ownerId != null ? ownerId.toString() : null);
                m.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
                m.put("runCount", rs.getInt("run_count"));
                m.put("totalCases", rs.getLong("total_cases"));
                m.put("passed", rs.getLong("passed"));
                m.put("failed", rs.getLong("failed"));
                m.put("untested", rs.getLong("untested"));
                long total = rs.getLong("total_cases");
                long executed = total - rs.getLong("untested");
                m.put("completionPercent", total > 0 ? Math.round((double) executed / total * 100) : 0);
                out.add(m);
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return out;
    }

    public static Optional<Map<String, Object>> get(UUID planId, UUID userId) {
        UUID projectId = getProjectId(planId);
        RbacService.requireProjectRole(userId, projectId);
        String sql = "SELECT id, project_id, external_id, name, description, target_release, owner_id, created_at, updated_at FROM plans WHERE id = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, planId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) {
                Object ownerId = rs.getObject("owner_id");
                Map<String, Object> m = new java.util.LinkedHashMap<>();
                m.put("id", rs.getObject("id").toString());
                m.put("projectId", rs.getObject("project_id").toString());
                m.put("externalId", rs.getString("external_id") != null ? rs.getString("external_id") : "");
                m.put("name", rs.getString("name"));
                m.put("description", rs.getString("description") != null ? rs.getString("description") : "");
                m.put("targetRelease", rs.getString("target_release") != null ? rs.getString("target_release") : "");
                m.put("ownerId", ownerId != null ? ownerId.toString() : null);
                m.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
                m.put("updatedAt", rs.getTimestamp("updated_at").toInstant().toString());
                return Optional.of(m);
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return Optional.empty();
    }

    public static Map<String, Object> create(UUID projectId, UUID userId, String name, String description, String targetRelease) {
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canManagePlansCycles())
            throw new io.javalin.http.ForbiddenResponse("Cannot create plans");
        String externalId = nextPlanExternalId(projectId);
        String sql = "INSERT INTO plans (project_id, external_id, name, description, target_release, owner_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, external_id, name, created_at";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ps.setString(2, externalId);
            ps.setString(3, name);
            ps.setString(4, description != null ? description : "");
            ps.setString(5, targetRelease);
            ps.setObject(6, userId);
            ResultSet rs = ps.executeQuery();
            rs.next();
            return Map.of(
                    "id", rs.getObject("id").toString(),
                    "externalId", rs.getString("external_id"),
                    "name", rs.getString("name"),
                    "createdAt", rs.getTimestamp("created_at").toInstant().toString()
            );
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static void update(UUID planId, UUID userId, String name, String description, String targetRelease) {
        UUID projectId = getProjectId(planId);
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canManagePlansCycles())
            throw new io.javalin.http.ForbiddenResponse("Cannot update plan");
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("UPDATE plans SET name = COALESCE(?, name), description = COALESCE(?, description), target_release = COALESCE(?, target_release), updated_at = now() WHERE id = ?")) {
            ps.setString(1, name);
            ps.setString(2, description);
            ps.setString(3, targetRelease);
            ps.setObject(4, planId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static void delete(UUID planId, UUID userId) {
        UUID projectId = getProjectId(planId);
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canManagePlansCycles())
            throw new io.javalin.http.ForbiddenResponse("Cannot delete plan");
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("DELETE FROM plans WHERE id = ?")) {
            ps.setObject(1, planId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static List<Map<String, Object>> listItems(UUID planId, UUID userId) {
        UUID projectId = getProjectId(planId);
        RbacService.requireProjectRole(userId, projectId);
        String sql = "SELECT pi.id, pi.suite_id, pi.testcase_id, pi.position FROM plan_items pi WHERE pi.plan_id = ? ORDER BY pi.position";
        List<Map<String, Object>> out = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, planId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                Object suiteId = rs.getObject("suite_id");
                Object testcaseId = rs.getObject("testcase_id");
                out.add(Map.of(
                        "id", rs.getObject("id").toString(),
                        "suiteId", suiteId != null ? suiteId.toString() : null,
                        "testcaseId", testcaseId != null ? testcaseId.toString() : null,
                        "position", rs.getInt("position")
                ));
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return out;
    }

    /** Resolve plan to flat list of test case ids (expand suites to cases). */
    public static List<UUID> resolveCaseIds(UUID planId, UUID projectId) {
        List<UUID> caseIds = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("SELECT suite_id, testcase_id FROM plan_items WHERE plan_id = ? ORDER BY position")) {
            ps.setObject(1, planId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                Object suiteId = rs.getObject("suite_id");
                Object tcId = rs.getObject("testcase_id");
                if (tcId != null) {
                    caseIds.add((UUID) tcId);
                } else if (suiteId != null) {
                    List<UUID> inSuite = getTestCaseIdsInSuite(c, (UUID) suiteId);
                    caseIds.addAll(inSuite);
                }
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return caseIds;
    }

    private static List<UUID> getTestCaseIdsInSuite(Connection c, UUID suiteId) throws SQLException {
        List<UUID> out = new ArrayList<>();
        try (PreparedStatement ps = c.prepareStatement("SELECT id FROM suites WHERE parent_id = ?")) {
            ps.setObject(1, suiteId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) out.addAll(getTestCaseIdsInSuite(c, (UUID) rs.getObject("id")));
        }
        try (PreparedStatement ps = c.prepareStatement("SELECT id FROM testcases WHERE suite_id = ?")) {
            ps.setObject(1, suiteId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) out.add((UUID) rs.getObject("id"));
        }
        return out;
    }

    public static void addItem(UUID planId, UUID userId, UUID suiteId, UUID testcaseId, int position) {
        UUID projectId = getProjectId(planId);
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canManagePlansCycles())
            throw new io.javalin.http.ForbiddenResponse("Cannot edit plan");
        if (suiteId == null && testcaseId == null) throw new IllegalArgumentException("suiteId or testcaseId required");
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("INSERT INTO plan_items (plan_id, suite_id, testcase_id, position) VALUES (?, ?, ?, ?)")) {
            ps.setObject(1, planId);
            ps.setObject(2, suiteId);
            ps.setObject(3, testcaseId);
            ps.setInt(4, position);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static void removeItem(UUID planId, UUID userId, UUID itemId) {
        UUID projectId = getProjectId(planId);
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canManagePlansCycles())
            throw new io.javalin.http.ForbiddenResponse("Cannot edit plan");
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("DELETE FROM plan_items WHERE id = ? AND plan_id = ?")) {
            ps.setObject(1, itemId);
            ps.setObject(2, planId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    /** List all cycles (runs) associated with a plan, including execution status counts. */
    public static List<Map<String, Object>> listRuns(UUID planId, UUID userId) {
        UUID projectId = getProjectId(planId);
        RbacService.requireProjectRole(userId, projectId);
        String sql = """
            SELECT c.id, c.external_id, c.name, c.description, c.status, c.environment, c.build_version,
                   c.release_name, c.started_at, c.ended_at, c.owner_id, c.created_at,
                   (SELECT COUNT(*) FROM cycle_items ci WHERE ci.cycle_id = c.id) AS total_cases,
                   (SELECT COUNT(*) FROM cycle_items ci JOIN executions e ON e.cycle_item_id = ci.id
                    WHERE ci.cycle_id = c.id AND e.status = 'Passed') AS passed,
                   (SELECT COUNT(*) FROM cycle_items ci JOIN executions e ON e.cycle_item_id = ci.id
                    WHERE ci.cycle_id = c.id AND e.status = 'Failed') AS failed,
                   (SELECT COUNT(*) FROM cycle_items ci JOIN executions e ON e.cycle_item_id = ci.id
                    WHERE ci.cycle_id = c.id AND e.status = 'Blocked') AS blocked,
                   (SELECT COUNT(*) FROM cycle_items ci JOIN executions e ON e.cycle_item_id = ci.id
                    WHERE ci.cycle_id = c.id AND e.status = 'Skipped') AS skipped,
                   (SELECT COUNT(*) FROM cycle_items ci JOIN executions e ON e.cycle_item_id = ci.id
                    WHERE ci.cycle_id = c.id AND e.status = 'Untested') AS untested
            FROM cycles c WHERE c.plan_id = ? ORDER BY c.created_at DESC
            """;
        List<Map<String, Object>> out = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, planId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                Map<String, Object> m = new java.util.LinkedHashMap<>();
                m.put("id", rs.getObject("id").toString());
                m.put("externalId", rs.getString("external_id") != null ? rs.getString("external_id") : "");
                m.put("name", rs.getString("name"));
                m.put("description", rs.getString("description") != null ? rs.getString("description") : "");
                m.put("status", rs.getString("status") != null ? rs.getString("status") : "Planning");
                m.put("environment", rs.getString("environment") != null ? rs.getString("environment") : "");
                m.put("buildVersion", rs.getString("build_version") != null ? rs.getString("build_version") : "");
                m.put("releaseName", rs.getString("release_name") != null ? rs.getString("release_name") : "");
                Object started = rs.getTimestamp("started_at");
                Object ended = rs.getTimestamp("ended_at");
                m.put("startedAt", started != null ? ((java.sql.Timestamp) started).toInstant().toString() : null);
                m.put("endedAt", ended != null ? ((java.sql.Timestamp) ended).toInstant().toString() : null);
                Object ownerId = rs.getObject("owner_id");
                m.put("ownerId", ownerId != null ? ownerId.toString() : null);
                m.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
                m.put("totalCases", rs.getInt("total_cases"));
                m.put("passed", rs.getInt("passed"));
                m.put("failed", rs.getInt("failed"));
                m.put("blocked", rs.getInt("blocked"));
                m.put("skipped", rs.getInt("skipped"));
                m.put("untested", rs.getInt("untested"));
                out.add(m);
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return out;
    }

    /** Aggregate progress across all runs associated with a plan. */
    public static Map<String, Object> getProgress(UUID planId, UUID userId) {
        UUID projectId = getProjectId(planId);
        RbacService.requireProjectRole(userId, projectId);
        String sql = """
            SELECT
                COUNT(DISTINCT c.id) AS run_count,
                COALESCE(SUM(sub.total), 0) AS total_cases,
                COALESCE(SUM(sub.passed), 0) AS passed,
                COALESCE(SUM(sub.failed), 0) AS failed,
                COALESCE(SUM(sub.blocked), 0) AS blocked,
                COALESCE(SUM(sub.skipped), 0) AS skipped,
                COALESCE(SUM(sub.untested), 0) AS untested
            FROM cycles c
            LEFT JOIN LATERAL (
                SELECT
                    COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE e.status = 'Passed') AS passed,
                    COUNT(*) FILTER (WHERE e.status = 'Failed') AS failed,
                    COUNT(*) FILTER (WHERE e.status = 'Blocked') AS blocked,
                    COUNT(*) FILTER (WHERE e.status = 'Skipped') AS skipped,
                    COUNT(*) FILTER (WHERE e.status = 'Untested') AS untested
                FROM cycle_items ci
                JOIN executions e ON e.cycle_item_id = ci.id
                WHERE ci.cycle_id = c.id
            ) sub ON true
            WHERE c.plan_id = ?
            """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, planId);
            ResultSet rs = ps.executeQuery();
            rs.next();
            Map<String, Object> m = new java.util.LinkedHashMap<>();
            m.put("runCount", rs.getInt("run_count"));
            m.put("totalCases", rs.getLong("total_cases"));
            m.put("passed", rs.getLong("passed"));
            m.put("failed", rs.getLong("failed"));
            m.put("blocked", rs.getLong("blocked"));
            m.put("skipped", rs.getLong("skipped"));
            m.put("untested", rs.getLong("untested"));
            long total = rs.getLong("total_cases");
            long executed = total - rs.getLong("untested");
            m.put("executed", executed);
            m.put("completionPercent", total > 0 ? Math.round((double) executed / total * 100) : 0);
            return m;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static UUID getProjectIdForPlan(UUID planId) {
        return getProjectId(planId);
    }

    private static UUID getProjectId(UUID planId) {
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("SELECT project_id FROM plans WHERE id = ?")) {
            ps.setObject(1, planId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) return (UUID) rs.getObject("project_id");
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        throw new io.javalin.http.NotFoundResponse();
    }
}
