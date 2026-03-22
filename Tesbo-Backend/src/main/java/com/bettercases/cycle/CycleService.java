package com.bettercases.cycle;

import com.bettercases.Database;
import com.bettercases.plan.PlanService;
import com.bettercases.rbac.RbacService;

import java.sql.*;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

public final class CycleService {

    private static final java.util.Set<String> VALID_STATUSES =
            java.util.Set.of("Planning", "In Progress", "Hold", "Completed");

    private static String getCycleStatus(UUID cycleId) {
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("SELECT status FROM cycles WHERE id = ?")) {
            ps.setObject(1, cycleId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) return rs.getString("status");
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        throw new io.javalin.http.NotFoundResponse();
    }

    private static void requireNotCompleted(UUID cycleId) {
        String status = getCycleStatus(cycleId);
        if ("Completed".equals(status)) {
            throw new io.javalin.http.BadRequestResponse(
                    "Test run is completed and cannot be modified");
        }
    }

    private static void requireEditableStatus(UUID cycleId) {
        String status = getCycleStatus(cycleId);
        if (!"Planning".equals(status) && !"In Progress".equals(status)) {
            throw new io.javalin.http.BadRequestResponse(
                    "Test run must be in Planning or In Progress status to perform this action");
        }
    }

    public static String nextCycleExternalId(UUID projectId) {
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
        String likePattern = keyPrefix + "-TR-%";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("SELECT COALESCE(MAX(CAST(SUBSTRING(external_id FROM '[0-9]+$') AS INTEGER)), 0) + 1 AS n FROM cycles WHERE project_id = ? AND external_id LIKE ?")) {
            ps.setObject(1, projectId);
            ps.setString(2, likePattern);
            ResultSet rs = ps.executeQuery();
            rs.next();
            int n = rs.getInt("n");
            return keyPrefix + "-TR-" + String.format("%02d", n);
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    /* ───── LIST all cycles in a project ───── */
    public static List<Map<String, Object>> list(UUID projectId, UUID userId) {
        RbacService.requireProjectRole(userId, projectId);
        String sql = """
            SELECT c.id, c.external_id, c.plan_id, c.name, c.description, c.status, c.environment, c.build_version,
                   c.release_name, c.started_at, c.ended_at, c.owner_id, c.created_at,
                   (SELECT COUNT(*) FROM cycle_items ci WHERE ci.cycle_id = c.id) AS total_cases,
                   (SELECT COUNT(*) FROM cycle_items ci JOIN executions e ON e.cycle_item_id = ci.id
                    WHERE ci.cycle_id = c.id AND e.status = 'Passed') AS passed,
                   (SELECT COUNT(*) FROM cycle_items ci JOIN executions e ON e.cycle_item_id = ci.id
                    WHERE ci.cycle_id = c.id AND e.status = 'Failed') AS failed
            FROM cycles c WHERE c.project_id = ? ORDER BY c.created_at DESC
            """;
        List<Map<String, Object>> out = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("id", rs.getObject("id").toString());
                m.put("externalId", rs.getString("external_id") != null ? rs.getString("external_id") : "");
                Object planIdObj = rs.getObject("plan_id");
                m.put("planId", planIdObj != null ? planIdObj.toString() : null);
                m.put("name", rs.getString("name"));
                m.put("description", rs.getString("description") != null ? rs.getString("description") : "");
                m.put("status", rs.getString("status") != null ? rs.getString("status") : "Planning");
                m.put("environment", rs.getString("environment") != null ? rs.getString("environment") : "");
                m.put("buildVersion", rs.getString("build_version") != null ? rs.getString("build_version") : "");
                m.put("releaseName", rs.getString("release_name") != null ? rs.getString("release_name") : "");
                Object started = rs.getTimestamp("started_at");
                Object ended = rs.getTimestamp("ended_at");
                m.put("startedAt", started != null ? ((Timestamp) started).toInstant().toString() : null);
                m.put("endedAt", ended != null ? ((Timestamp) ended).toInstant().toString() : null);
                Object ownerId = rs.getObject("owner_id");
                m.put("ownerId", ownerId != null ? ownerId.toString() : null);
                m.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
                m.put("totalCases", rs.getInt("total_cases"));
                m.put("passed", rs.getInt("passed"));
                m.put("failed", rs.getInt("failed"));
                out.add(m);
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return out;
    }

    /* ───── GET single cycle detail ───── */
    public static Optional<Map<String, Object>> get(UUID cycleId, UUID userId) {
        UUID projectId = getProjectId(cycleId);
        RbacService.requireProjectRole(userId, projectId);
        String sql = """
            SELECT id, external_id, project_id, plan_id, name, description, status, environment,
                   build_version, release_name, started_at, ended_at, owner_id,
                   share_token, share_enabled,
                   created_at, updated_at
            FROM cycles WHERE id = ?
            """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, cycleId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) {
                return Optional.of(mapCycleRow(rs));
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return Optional.empty();
    }

    /* ───── helper to map a cycle ResultSet row ───── */
    private static Map<String, Object> mapCycleRow(ResultSet rs) throws SQLException {
        Map<String, Object> m = new HashMap<>();
        m.put("id", rs.getObject("id").toString());
        m.put("externalId", rs.getString("external_id") != null ? rs.getString("external_id") : "");
        m.put("projectId", rs.getObject("project_id").toString());
        Object planId = rs.getObject("plan_id");
        m.put("planId", planId != null ? planId.toString() : null);
        m.put("name", rs.getString("name"));
        m.put("description", rs.getString("description") != null ? rs.getString("description") : "");
        m.put("status", rs.getString("status") != null ? rs.getString("status") : "Planning");
        m.put("environment", rs.getString("environment") != null ? rs.getString("environment") : "");
        m.put("buildVersion", rs.getString("build_version") != null ? rs.getString("build_version") : "");
        m.put("releaseName", rs.getString("release_name") != null ? rs.getString("release_name") : "");
        Object started = rs.getTimestamp("started_at");
        Object ended = rs.getTimestamp("ended_at");
        m.put("startedAt", started != null ? ((Timestamp) started).toInstant().toString() : null);
        m.put("endedAt", ended != null ? ((Timestamp) ended).toInstant().toString() : null);
        Object ownerId = rs.getObject("owner_id");
        m.put("ownerId", ownerId != null ? ownerId.toString() : null);
        m.put("shareToken", rs.getString("share_token"));
        m.put("shareEnabled", rs.getBoolean("share_enabled"));
        m.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
        m.put("updatedAt", rs.getTimestamp("updated_at").toInstant().toString());
        return m;
    }

    /* ───── CREATE a test run (initially Planning, no test cases) ───── */
    public static Map<String, Object> create(UUID projectId, UUID userId, String name, String description,
                                             String environment, String buildVersion) {
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canManagePlansCycles())
            throw new io.javalin.http.ForbiddenResponse("Cannot create test run");
        String externalId = nextCycleExternalId(projectId);
        String sql = "INSERT INTO cycles (project_id, external_id, name, description, environment, build_version, status, owner_id) " +
                     "VALUES (?, ?, ?, ?, ?, ?, 'Planning', ?) RETURNING id, external_id, created_at";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ps.setString(2, externalId);
            ps.setString(3, name);
            ps.setString(4, description != null ? description : "");
            ps.setString(5, environment != null ? environment : "");
            ps.setString(6, buildVersion != null ? buildVersion : "");
            ps.setObject(7, userId);
            ResultSet rs = ps.executeQuery();
            rs.next();
            return Map.of(
                "id", rs.getObject("id").toString(),
                "externalId", rs.getString("external_id"),
                "name", name,
                "status", "Planning",
                "createdAt", rs.getTimestamp("created_at").toInstant().toString()
            );
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    /* ───── UPDATE a test run ───── */
    public static void update(UUID cycleId, UUID userId, String name, String description,
                              String environment, String buildVersion, String status,
                              UUID planId, boolean clearPlan) {
        UUID projectId = getProjectId(cycleId);
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canManagePlansCycles())
            throw new io.javalin.http.ForbiddenResponse("Cannot update test run");

        String currentStatus = getCycleStatus(cycleId);

        if ("Completed".equals(currentStatus)) {
            throw new io.javalin.http.BadRequestResponse(
                    "Test run is completed and cannot be modified");
        }

        if (status != null && !VALID_STATUSES.contains(status)) {
            throw new io.javalin.http.BadRequestResponse(
                    "Invalid status: " + status + ". Valid statuses are: Planning, In Progress, Hold, Completed");
        }

        try (Connection c = Database.getDataSource().getConnection()) {
            // Update plan_id separately if requested, to keep the main query simple
            if (clearPlan) {
                try (PreparedStatement ps = c.prepareStatement("UPDATE cycles SET plan_id = NULL, updated_at = now() WHERE id = ?")) {
                    ps.setObject(1, cycleId);
                    ps.executeUpdate();
                }
            } else if (planId != null) {
                try (PreparedStatement ps = c.prepareStatement("UPDATE cycles SET plan_id = ?, updated_at = now() WHERE id = ?")) {
                    ps.setObject(1, planId);
                    ps.setObject(2, cycleId);
                    ps.executeUpdate();
                }
            }

            String sql = """
                UPDATE cycles SET
                  name = COALESCE(?, name),
                  description = COALESCE(?, description),
                  environment = COALESCE(?, environment),
                  build_version = COALESCE(?, build_version),
                  status = COALESCE(?, status),
                  started_at = CASE WHEN ? = 'In Progress' AND started_at IS NULL THEN now() ELSE started_at END,
                  ended_at = CASE WHEN ? = 'Completed' AND ended_at IS NULL THEN now() ELSE ended_at END,
                  updated_at = now()
                WHERE id = ?
                """;
            try (PreparedStatement ps = c.prepareStatement(sql)) {
                ps.setString(1, name);
                ps.setString(2, description);
                ps.setString(3, environment);
                ps.setString(4, buildVersion);
                ps.setString(5, status);
                ps.setString(6, status);
                ps.setString(7, status);
                ps.setObject(8, cycleId);
                ps.executeUpdate();
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    /* ───── DELETE a test run ───── */
    public static void delete(UUID cycleId, UUID userId) {
        UUID projectId = getProjectId(cycleId);
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canManagePlansCycles())
            throw new io.javalin.http.ForbiddenResponse("Cannot delete test run");
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("DELETE FROM cycles WHERE id = ?")) {
            ps.setObject(1, cycleId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    /* ───── ADD test cases to an existing test run ───── */
    public static void addTestCases(UUID cycleId, UUID userId, List<UUID> testcaseIds) {
        UUID projectId = getProjectId(cycleId);
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canManagePlansCycles())
            throw new io.javalin.http.ForbiddenResponse("Cannot modify test run");
        requireEditableStatus(cycleId);

        try (Connection c = Database.getDataSource().getConnection()) {
            c.setAutoCommit(false);
            // Get current max position
            int pos;
            try (PreparedStatement ps = c.prepareStatement("SELECT COALESCE(MAX(position), -1) FROM cycle_items WHERE cycle_id = ?")) {
                ps.setObject(1, cycleId);
                ResultSet rs = ps.executeQuery();
                rs.next();
                pos = rs.getInt(1) + 1;
            }
            // Get already-included testcase IDs to avoid duplicates
            List<UUID> existing = new ArrayList<>();
            try (PreparedStatement ps = c.prepareStatement("SELECT testcase_id FROM cycle_items WHERE cycle_id = ?")) {
                ps.setObject(1, cycleId);
                ResultSet rs = ps.executeQuery();
                while (rs.next()) existing.add((UUID) rs.getObject("testcase_id"));
            }
            for (UUID tcId : testcaseIds) {
                if (existing.contains(tcId)) continue;
                String title = getTestCaseTitle(c, tcId);
                UUID cycleItemId;
                try (PreparedStatement ps = c.prepareStatement("INSERT INTO cycle_items (cycle_id, testcase_id, snapshot_title, position) VALUES (?, ?, ?, ?) RETURNING id")) {
                    ps.setObject(1, cycleId);
                    ps.setObject(2, tcId);
                    ps.setString(3, title);
                    ps.setInt(4, pos++);
                    ResultSet rs = ps.executeQuery();
                    rs.next();
                    cycleItemId = (UUID) rs.getObject("id");
                }
                try (PreparedStatement ps = c.prepareStatement("INSERT INTO executions (cycle_item_id, status) VALUES (?, 'Untested')")) {
                    ps.setObject(1, cycleItemId);
                    ps.executeUpdate();
                }
            }
            c.commit();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    /* ───── REMOVE a test case from a test run ───── */
    public static void removeTestCase(UUID cycleId, UUID userId, UUID testcaseId) {
        UUID projectId = getProjectId(cycleId);
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canManagePlansCycles())
            throw new io.javalin.http.ForbiddenResponse("Cannot modify test run");
        requireEditableStatus(cycleId);
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("DELETE FROM cycle_items WHERE cycle_id = ? AND testcase_id = ?")) {
            ps.setObject(1, cycleId);
            ps.setObject(2, testcaseId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    /* ───── CREATE from plan (existing feature) ───── */
    public static Map<String, Object> createFromPlan(UUID projectId, UUID userId, UUID planId, String name, String environment, String buildVersion) {
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canManagePlansCycles())
            throw new io.javalin.http.ForbiddenResponse("Cannot create cycle");
        List<UUID> caseIds = PlanService.resolveCaseIds(planId, projectId);
        return createCycleWithCases(projectId, userId, planId, name, environment, buildVersion, caseIds);
    }

    /* ───── CREATE from cases (existing feature) ───── */
    public static Map<String, Object> createFromCases(UUID projectId, UUID userId, String name, String environment, String buildVersion, List<UUID> testcaseIds) {
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canManagePlansCycles())
            throw new io.javalin.http.ForbiddenResponse("Cannot create cycle");
        return createCycleWithCases(projectId, userId, null, name, environment, buildVersion, testcaseIds);
    }

    private static Map<String, Object> createCycleWithCases(UUID projectId, UUID userId, UUID planId, String name, String environment, String buildVersion, List<UUID> testcaseIds) {
        String externalId = nextCycleExternalId(projectId);
        try (Connection c = Database.getDataSource().getConnection()) {
            c.setAutoCommit(false);
            UUID cycleId;
            try (PreparedStatement ps = c.prepareStatement("INSERT INTO cycles (project_id, external_id, plan_id, name, environment, build_version, status, owner_id) VALUES (?, ?, ?, ?, ?, ?, 'Planning', ?) RETURNING id")) {
                ps.setObject(1, projectId);
                ps.setString(2, externalId);
                ps.setObject(3, planId);
                ps.setString(4, name);
                ps.setString(5, environment != null ? environment : "");
                ps.setString(6, buildVersion != null ? buildVersion : "");
                ps.setObject(7, userId);
                ResultSet rs = ps.executeQuery();
                rs.next();
                cycleId = (UUID) rs.getObject("id");
            }
            int pos = 0;
            for (UUID tcId : testcaseIds) {
                String title = getTestCaseTitle(c, tcId);
                UUID cycleItemId;
                try (PreparedStatement ps = c.prepareStatement("INSERT INTO cycle_items (cycle_id, testcase_id, snapshot_title, position) VALUES (?, ?, ?, ?) RETURNING id")) {
                    ps.setObject(1, cycleId);
                    ps.setObject(2, tcId);
                    ps.setString(3, title);
                    ps.setInt(4, pos++);
                    ResultSet rs = ps.executeQuery();
                    rs.next();
                    cycleItemId = (UUID) rs.getObject("id");
                }
                try (PreparedStatement ps = c.prepareStatement("INSERT INTO executions (cycle_item_id, status) VALUES (?, 'Untested')")) {
                    ps.setObject(1, cycleItemId);
                    ps.executeUpdate();
                }
            }
            c.commit();
            return Map.of("id", cycleId.toString(), "externalId", externalId, "name", name, "status", "Planning");
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static String getTestCaseTitle(Connection c, UUID testcaseId) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement("SELECT title FROM testcases WHERE id = ?")) {
            ps.setObject(1, testcaseId);
            ResultSet rs = ps.executeQuery();
            return rs.next() ? rs.getString("title") : "";
        }
    }

    /* ───── LIST executions for a cycle (authenticated) ───── */
    public static List<Map<String, Object>> listExecutions(UUID cycleId, UUID userId) {
        UUID projectId = getProjectId(cycleId);
        RbacService.requireProjectRole(userId, projectId);
        return listExecutionsInternal(cycleId);
    }

    /* ───── UPDATE execution ───── */
    public static void updateExecution(UUID executionId, UUID userId, String status, UUID assigneeId,
                                       String actualResult, String defectKey, String defectUrl) {
        UUID cycleId = getCycleIdByExecution(executionId);
        UUID projectId = getProjectId(cycleId);
        RbacService.requireProjectRole(userId, projectId);
        requireEditableStatus(cycleId);
        com.bettercases.rbac.Role r = RbacService.getProjectRole(userId, projectId).get();
        if (!r.canExecute() && !r.canEditOthersExecutions())
            throw new io.javalin.http.ForbiddenResponse("Cannot update execution");

        UUID effectiveAssignee = assigneeId;
        if (effectiveAssignee == null && status != null) {
            effectiveAssignee = resolveAssigneeIfUnset(executionId, userId);
        }

        String sql = """
            UPDATE executions SET
              status = COALESCE(?, status),
              assignee_id = COALESCE(?, assignee_id),
              actual_result = COALESCE(?, actual_result),
              defect_key = ?,
              defect_url = ?,
              executed_at = CASE WHEN ? IS NOT NULL THEN now() ELSE executed_at END,
              updated_at = now()
            WHERE id = ?
            """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, status);
            ps.setObject(2, effectiveAssignee);
            ps.setString(3, actualResult);
            ps.setString(4, defectKey);
            ps.setString(5, defectUrl);
            ps.setString(6, status);
            ps.setObject(7, executionId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    /* ───── BULK assign ───── */
    public static void bulkAssign(UUID cycleId, UUID userId, List<UUID> executionIds, UUID assigneeId) {
        UUID projectId = getProjectId(cycleId);
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canManagePlansCycles())
            throw new io.javalin.http.ForbiddenResponse("Cannot assign");
        requireEditableStatus(cycleId);
        try (Connection c = Database.getDataSource().getConnection()) {
            for (UUID execId : executionIds) {
                try (PreparedStatement ps = c.prepareStatement("UPDATE executions SET assignee_id = ? WHERE id = ?")) {
                    ps.setObject(1, assigneeId);
                    ps.setObject(2, execId);
                    ps.executeUpdate();
                }
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    /* ───── BULK update status ───── */
    public static void bulkUpdateStatus(UUID cycleId, UUID userId, List<UUID> executionIds, String status) {
        UUID projectId = getProjectId(cycleId);
        RbacService.requireProjectRole(userId, projectId);
        com.bettercases.rbac.Role r = RbacService.getProjectRole(userId, projectId).get();
        if (!r.canExecute() && !r.canEditOthersExecutions())
            throw new io.javalin.http.ForbiddenResponse("Cannot update status");
        requireEditableStatus(cycleId);
        try (Connection c = Database.getDataSource().getConnection()) {
            for (UUID execId : executionIds) {
                try (PreparedStatement ps = c.prepareStatement(
                        "UPDATE executions SET status = ?, assignee_id = COALESCE(assignee_id, ?), executed_at = now(), updated_at = now() WHERE id = ?")) {
                    ps.setString(1, status);
                    ps.setObject(2, userId);
                    ps.setObject(3, execId);
                    ps.executeUpdate();
                }
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    /* ═══════════════════ PUBLIC SHARING ═══════════════════ */

    /** Enable sharing – generates a token if one doesn't exist. Disable sharing. Returns current share state. */
    public static Map<String, Object> toggleShare(UUID cycleId, UUID userId, boolean enabled) {
        UUID projectId = getProjectId(cycleId);
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canManagePlansCycles())
            throw new io.javalin.http.ForbiddenResponse("Cannot manage sharing");

        try (Connection c = Database.getDataSource().getConnection()) {
            // If enabling and no token yet, generate one
            if (enabled) {
                try (PreparedStatement ps = c.prepareStatement("SELECT share_token FROM cycles WHERE id = ?")) {
                    ps.setObject(1, cycleId);
                    ResultSet rs = ps.executeQuery();
                    rs.next();
                    String existingToken = rs.getString("share_token");
                    if (existingToken == null || existingToken.isEmpty()) {
                        String token = generateShareToken();
                        try (PreparedStatement up = c.prepareStatement(
                                "UPDATE cycles SET share_token = ?, share_enabled = true, updated_at = now() WHERE id = ?")) {
                            up.setString(1, token);
                            up.setObject(2, cycleId);
                            up.executeUpdate();
                        }
                        return Map.of("shareToken", token, "shareEnabled", true);
                    }
                }
            }
            // Just toggle the flag
            try (PreparedStatement ps = c.prepareStatement(
                    "UPDATE cycles SET share_enabled = ?, updated_at = now() WHERE id = ? RETURNING share_token, share_enabled")) {
                ps.setBoolean(1, enabled);
                ps.setObject(2, cycleId);
                ResultSet rs = ps.executeQuery();
                rs.next();
                String token = rs.getString("share_token");
                return Map.of(
                    "shareToken", token != null ? token : "",
                    "shareEnabled", rs.getBoolean("share_enabled")
                );
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    /** Get test run by share token (public, no auth). Returns empty if not found or sharing disabled. */
    public static Optional<Map<String, Object>> getByShareToken(String token) {
        String sql = """
            SELECT id, project_id, plan_id, name, description, status, environment,
                   build_version, release_name, started_at, ended_at, owner_id,
                   share_token, share_enabled,
                   created_at, updated_at
            FROM cycles WHERE share_token = ? AND share_enabled = true
            """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, token);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) {
                return Optional.of(mapCycleRow(rs));
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return Optional.empty();
    }

    /** Get executions for a public shared test run (no auth, looks up by share token). */
    public static List<Map<String, Object>> listExecutionsByShareToken(String token) {
        // First verify sharing is enabled and get the cycle id
        String lookupSql = "SELECT id FROM cycles WHERE share_token = ? AND share_enabled = true";
        UUID cycleId;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(lookupSql)) {
            ps.setString(1, token);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) return List.of();
            cycleId = (UUID) rs.getObject("id");
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return listExecutionsInternal(cycleId);
    }

    /** Internal execution list (no auth check) used by both authenticated and public paths. */
    private static List<Map<String, Object>> listExecutionsInternal(UUID cycleId) {
        String sql = """
            SELECT e.id AS exec_id, ci.id AS cycle_item_id, ci.testcase_id,
                   ci.snapshot_title, e.status AS exec_status,
                   e.assignee_id, e.actual_result, e.executed_at,
                   e.defect_key, e.defect_url,
                   tc.external_id, tc.priority, tc.type AS tc_type
            FROM cycle_items ci
            JOIN executions e ON e.cycle_item_id = ci.id
            LEFT JOIN testcases tc ON tc.id = ci.testcase_id
            WHERE ci.cycle_id = ?
            ORDER BY ci.position
            """;
        List<Map<String, Object>> out = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, cycleId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("id", rs.getObject("exec_id").toString());
                m.put("cycleItemId", rs.getObject("cycle_item_id").toString());
                m.put("testcaseId", rs.getObject("testcase_id").toString());
                m.put("title", rs.getString("snapshot_title") != null ? rs.getString("snapshot_title") : "");
                m.put("externalId", rs.getString("external_id") != null ? rs.getString("external_id") : "");
                m.put("priority", rs.getString("priority") != null ? rs.getString("priority") : "");
                m.put("type", rs.getString("tc_type") != null ? rs.getString("tc_type") : "");
                m.put("status", rs.getString("exec_status"));
                Object assigneeId = rs.getObject("assignee_id");
                m.put("assigneeId", assigneeId != null ? assigneeId.toString() : null);
                m.put("actualResult", rs.getString("actual_result") != null ? rs.getString("actual_result") : "");
                Object executedAt = rs.getTimestamp("executed_at");
                m.put("executedAt", executedAt != null ? ((Timestamp) executedAt).toInstant().toString() : null);
                m.put("defectKey", rs.getString("defect_key") != null ? rs.getString("defect_key") : "");
                m.put("defectUrl", rs.getString("defect_url") != null ? rs.getString("defect_url") : "");
                out.add(m);
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return out;
    }

    private static String generateShareToken() {
        // Generate a URL-safe random token (32 bytes = 43 chars in base64url)
        byte[] bytes = new byte[32];
        new java.security.SecureRandom().nextBytes(bytes);
        return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    /** Returns userId if the execution currently has no assignee, otherwise null (letting COALESCE keep the existing value). */
    private static UUID resolveAssigneeIfUnset(UUID executionId, UUID userId) {
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("SELECT assignee_id FROM executions WHERE id = ?")) {
            ps.setObject(1, executionId);
            ResultSet rs = ps.executeQuery();
            if (rs.next() && rs.getObject("assignee_id") == null) {
                return userId;
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return null;
    }

    /* ───── helpers ───── */
    private static UUID getCycleIdByExecution(UUID executionId) {
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(
                 "SELECT ci.cycle_id FROM executions e JOIN cycle_items ci ON e.cycle_item_id = ci.id WHERE e.id = ?")) {
            ps.setObject(1, executionId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) return (UUID) rs.getObject("cycle_id");
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        throw new io.javalin.http.NotFoundResponse();
    }

    public static UUID getProjectIdForCycle(UUID cycleId) {
        return getProjectId(cycleId);
    }

    private static UUID getProjectId(UUID cycleId) {
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("SELECT project_id FROM cycles WHERE id = ?")) {
            ps.setObject(1, cycleId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) return (UUID) rs.getObject("project_id");
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        throw new io.javalin.http.NotFoundResponse();
    }
}
