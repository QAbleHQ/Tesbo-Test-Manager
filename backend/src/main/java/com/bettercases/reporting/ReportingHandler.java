package com.bettercases.reporting;

import com.bettercases.auth.SessionFilter;
import com.bettercases.Database;
import com.bettercases.rbac.RbacService;
import com.bettercases.workspace.WorkspaceService;

import io.javalin.http.Context;

import java.sql.*;
import java.util.*;

public final class ReportingHandler {

    private static final String WORKSPACE_PROJECTS_JOIN = " FROM projects p " +
        "JOIN project_members pm ON p.id = pm.project_id " +
        "WHERE pm.user_id = ? AND p.organization_id = ? AND p.archived_at IS NULL ";

    /** Workspace-level analytics: counts and execution status across all projects in the user's workspace. */
    public static void workspaceAnalytics(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID orgId = WorkspaceService.getCurrentUserOrganizationId(userId)
            .orElseThrow(() -> new io.javalin.http.NotFoundResponse("No workspace found. Complete onboarding first."));

        Map<String, Object> out = new LinkedHashMap<>();

        try (Connection c = Database.getDataSource().getConnection()) {
            out.put("projectCount", workspaceCount(c, "SELECT COUNT(DISTINCT p.id)" + WORKSPACE_PROJECTS_JOIN, userId, orgId));
            out.put("testCaseCount", workspaceCount(c, "SELECT COUNT(*) FROM testcases tc JOIN projects p ON tc.project_id = p.id JOIN project_members pm ON p.id = pm.project_id WHERE pm.user_id = ? AND p.organization_id = ? AND p.archived_at IS NULL", userId, orgId));
            out.put("suiteCount", workspaceCount(c, "SELECT COUNT(*) FROM suites s JOIN projects p ON s.project_id = p.id JOIN project_members pm ON p.id = pm.project_id WHERE pm.user_id = ? AND p.organization_id = ? AND p.archived_at IS NULL", userId, orgId));
            out.put("planCount", workspaceCount(c, "SELECT COUNT(*) FROM plans pl JOIN projects p ON pl.project_id = p.id JOIN project_members pm ON p.id = pm.project_id WHERE pm.user_id = ? AND p.organization_id = ? AND p.archived_at IS NULL", userId, orgId));
            out.put("cycleCount", workspaceCount(c, "SELECT COUNT(*) FROM cycles cy JOIN projects p ON cy.project_id = p.id JOIN project_members pm ON p.id = pm.project_id WHERE pm.user_id = ? AND p.organization_id = ? AND p.archived_at IS NULL", userId, orgId));

            String statusSql = "SELECT e.status, COUNT(*) AS cnt FROM executions e " +
                "JOIN cycle_items ci ON e.cycle_item_id = ci.id " +
                "JOIN cycles cy ON ci.cycle_id = cy.id " +
                "JOIN projects p ON cy.project_id = p.id " +
                "JOIN project_members pm ON p.id = pm.project_id " +
                "WHERE pm.user_id = ? AND p.organization_id = ? AND p.archived_at IS NULL " +
                "GROUP BY e.status";
            Map<String, Integer> byStatus = new LinkedHashMap<>();
            int execTotal = 0;
            try (PreparedStatement ps = c.prepareStatement(statusSql)) {
                ps.setObject(1, userId);
                ps.setObject(2, orgId);
                ResultSet rs = ps.executeQuery();
                while (rs.next()) {
                    String status = rs.getString("status");
                    int cnt = rs.getInt("cnt");
                    byStatus.put(status, cnt);
                    execTotal += cnt;
                }
            }
            out.put("executionStatus", byStatus);
            out.put("executionTotal", execTotal);
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        ctx.json(out);
    }

    private static int workspaceCount(Connection c, String sql, UUID userId, UUID orgId) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, userId);
            ps.setObject(2, orgId);
            ResultSet rs = ps.executeQuery();
            return rs.next() ? rs.getInt(1) : 0;
        }
    }

    /** Project-level analytics: counts and execution status breakdown for dashboard. */
    public static void projectAnalytics(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        RbacService.requireProjectRole(userId, projectId);

        Map<String, Object> out = new LinkedHashMap<>();

        try (Connection c = Database.getDataSource().getConnection()) {
            out.put("testCaseCount", count(c, "SELECT COUNT(*) FROM testcases WHERE project_id = ?", projectId));
            out.put("suiteCount", count(c, "SELECT COUNT(*) FROM suites WHERE project_id = ?", projectId));
            out.put("planCount", count(c, "SELECT COUNT(*) FROM plans WHERE project_id = ?", projectId));
            out.put("cycleCount", count(c, "SELECT COUNT(*) FROM cycles WHERE project_id = ?", projectId));

            String statusSql = "SELECT e.status, COUNT(*) AS cnt FROM executions e " +
                "JOIN cycle_items ci ON e.cycle_item_id = ci.id " +
                "JOIN cycles cy ON ci.cycle_id = cy.id WHERE cy.project_id = ? GROUP BY e.status";
            Map<String, Integer> byStatus = new LinkedHashMap<>();
            int execTotal = 0;
            try (PreparedStatement ps = c.prepareStatement(statusSql)) {
                ps.setObject(1, projectId);
                ResultSet rs = ps.executeQuery();
                while (rs.next()) {
                    String status = rs.getString("status");
                    int cnt = rs.getInt("cnt");
                    byStatus.put(status, cnt);
                    execTotal += cnt;
                }
            }
            out.put("executionStatus", byStatus);
            out.put("executionTotal", execTotal);
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        ctx.json(out);
    }

    private static int count(Connection c, String sql, UUID projectId) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ResultSet rs = ps.executeQuery();
            return rs.next() ? rs.getInt(1) : 0;
        }
    }

    public static void cycleSummary(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID cycleId = UUID.fromString(ctx.pathParam("cycleId"));
        UUID projectId = getProjectId(cycleId);
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canViewReports())
            throw new io.javalin.http.ForbiddenResponse("Cannot view reports");
        String sql = "SELECT e.status, COUNT(*) AS cnt FROM executions e JOIN cycle_items ci ON e.cycle_item_id = ci.id WHERE ci.cycle_id = ? GROUP BY e.status";
        Map<String, Object> summary = new HashMap<>();
        summary.put("total", 0);
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, cycleId);
            ResultSet rs = ps.executeQuery();
            int total = 0;
            while (rs.next()) {
                String status = rs.getString("status");
                int cnt = rs.getInt("cnt");
                summary.put(status, cnt);
                total += cnt;
            }
            summary.put("total", total);
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        ctx.json(summary);
    }

    /* ═══════════════════════════════════════════════════════════════════
       Execution Report – filterable by person, plan, run, suite, tags, priority
       ═══════════════════════════════════════════════════════════════════ */
    public static void executionReport(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        RbacService.requireProjectRole(userId, projectId);

        String filterBy = ctx.queryParam("filterBy");
        String filterValue = ctx.queryParam("filterValue");

        List<Map<String, Object>> rows = new ArrayList<>();

        try (Connection c = Database.getDataSource().getConnection()) {
            if ("person".equals(filterBy)) {
                rows = executionByPerson(c, projectId, filterValue);
            } else if ("plan".equals(filterBy)) {
                rows = executionByPlan(c, projectId, filterValue);
            } else if ("run".equals(filterBy)) {
                rows = executionByRun(c, projectId, filterValue);
            } else if ("suite".equals(filterBy)) {
                rows = executionBySuite(c, projectId, filterValue);
            } else if ("tags".equals(filterBy)) {
                rows = executionByTags(c, projectId, filterValue);
            } else if ("priority".equals(filterBy)) {
                rows = executionByPriority(c, projectId, filterValue);
            } else {
                rows = executionOverall(c, projectId);
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("filterBy", filterBy != null ? filterBy : "overall");
        out.put("filterValue", filterValue);
        out.put("rows", rows);
        ctx.json(out);
    }

    private static List<Map<String, Object>> executionOverall(Connection c, UUID projectId) throws SQLException {
        String sql = "SELECT cy.name AS group_name, cy.id AS group_id, e.status, COUNT(*) AS cnt " +
            "FROM executions e " +
            "JOIN cycle_items ci ON e.cycle_item_id = ci.id " +
            "JOIN cycles cy ON ci.cycle_id = cy.id " +
            "WHERE cy.project_id = ? " +
            "GROUP BY cy.id, cy.name, e.status ORDER BY cy.name";
        return groupedStatusQuery(c, sql, projectId, null);
    }

    private static List<Map<String, Object>> executionByPerson(Connection c, UUID projectId, String filterValue) throws SQLException {
        String sql = "SELECT COALESCE(u.name, u.email, 'Unassigned') AS group_name, " +
            "COALESCE(e.assignee_id::text, 'unassigned') AS group_id, e.status, COUNT(*) AS cnt " +
            "FROM executions e " +
            "JOIN cycle_items ci ON e.cycle_item_id = ci.id " +
            "JOIN cycles cy ON ci.cycle_id = cy.id " +
            "LEFT JOIN users u ON e.assignee_id = u.id " +
            "WHERE cy.project_id = ? " +
            (filterValue != null && !filterValue.isEmpty() ? "AND (e.assignee_id::text = ? OR u.name ILIKE ? OR u.email ILIKE ?) " : "") +
            "GROUP BY group_name, group_id, e.status ORDER BY group_name";
        if (filterValue != null && !filterValue.isEmpty()) {
            return groupedStatusQueryMultiParam(c, sql, projectId, filterValue);
        }
        return groupedStatusQuery(c, sql, projectId, null);
    }

    private static List<Map<String, Object>> executionByPlan(Connection c, UUID projectId, String filterValue) throws SQLException {
        String sql = "SELECT COALESCE(pl.name, 'No Plan') AS group_name, " +
            "COALESCE(cy.plan_id::text, 'none') AS group_id, e.status, COUNT(*) AS cnt " +
            "FROM executions e " +
            "JOIN cycle_items ci ON e.cycle_item_id = ci.id " +
            "JOIN cycles cy ON ci.cycle_id = cy.id " +
            "LEFT JOIN plans pl ON cy.plan_id = pl.id " +
            "WHERE cy.project_id = ? " +
            (filterValue != null && !filterValue.isEmpty() ? "AND cy.plan_id::text = ? " : "") +
            "GROUP BY group_name, group_id, e.status ORDER BY group_name";
        return groupedStatusQuery(c, sql, projectId, filterValue);
    }

    private static List<Map<String, Object>> executionByRun(Connection c, UUID projectId, String filterValue) throws SQLException {
        String sql = "SELECT cy.name AS group_name, cy.id::text AS group_id, e.status, COUNT(*) AS cnt " +
            "FROM executions e " +
            "JOIN cycle_items ci ON e.cycle_item_id = ci.id " +
            "JOIN cycles cy ON ci.cycle_id = cy.id " +
            "WHERE cy.project_id = ? " +
            (filterValue != null && !filterValue.isEmpty() ? "AND cy.id::text = ? " : "") +
            "GROUP BY cy.id, cy.name, e.status ORDER BY cy.name";
        return groupedStatusQuery(c, sql, projectId, filterValue);
    }

    private static List<Map<String, Object>> executionBySuite(Connection c, UUID projectId, String filterValue) throws SQLException {
        String sql = "SELECT COALESCE(s.name, 'No Suite') AS group_name, " +
            "COALESCE(tc.suite_id::text, 'none') AS group_id, e.status, COUNT(*) AS cnt " +
            "FROM executions e " +
            "JOIN cycle_items ci ON e.cycle_item_id = ci.id " +
            "JOIN cycles cy ON ci.cycle_id = cy.id " +
            "LEFT JOIN testcases tc ON ci.testcase_id = tc.id " +
            "LEFT JOIN suites s ON tc.suite_id = s.id " +
            "WHERE cy.project_id = ? " +
            (filterValue != null && !filterValue.isEmpty() ? "AND tc.suite_id::text = ? " : "") +
            "GROUP BY group_name, group_id, e.status ORDER BY group_name";
        return groupedStatusQuery(c, sql, projectId, filterValue);
    }

    private static List<Map<String, Object>> executionByTags(Connection c, UUID projectId, String filterValue) throws SQLException {
        String sql = "SELECT COALESCE(tc.automation_tags, 'No Tags') AS group_name, " +
            "COALESCE(tc.automation_tags, 'none') AS group_id, e.status, COUNT(*) AS cnt " +
            "FROM executions e " +
            "JOIN cycle_items ci ON e.cycle_item_id = ci.id " +
            "JOIN cycles cy ON ci.cycle_id = cy.id " +
            "LEFT JOIN testcases tc ON ci.testcase_id = tc.id " +
            "WHERE cy.project_id = ? " +
            (filterValue != null && !filterValue.isEmpty() ? "AND tc.automation_tags ILIKE ? " : "") +
            "GROUP BY group_name, group_id, e.status ORDER BY group_name";
        if (filterValue != null && !filterValue.isEmpty()) {
            return groupedStatusQuery(c, sql, projectId, "%" + filterValue + "%");
        }
        return groupedStatusQuery(c, sql, projectId, null);
    }

    private static List<Map<String, Object>> executionByPriority(Connection c, UUID projectId, String filterValue) throws SQLException {
        String sql = "SELECT COALESCE(tc.priority, 'Unknown') AS group_name, " +
            "COALESCE(tc.priority, 'unknown') AS group_id, e.status, COUNT(*) AS cnt " +
            "FROM executions e " +
            "JOIN cycle_items ci ON e.cycle_item_id = ci.id " +
            "JOIN cycles cy ON ci.cycle_id = cy.id " +
            "LEFT JOIN testcases tc ON ci.testcase_id = tc.id " +
            "WHERE cy.project_id = ? " +
            (filterValue != null && !filterValue.isEmpty() ? "AND tc.priority = ? " : "") +
            "GROUP BY group_name, group_id, e.status ORDER BY group_name";
        return groupedStatusQuery(c, sql, projectId, filterValue);
    }

    private static List<Map<String, Object>> groupedStatusQuery(Connection c, String sql, UUID projectId, String filterValue) throws SQLException {
        Map<String, Map<String, Object>> grouped = new LinkedHashMap<>();
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            int idx = 1;
            ps.setObject(idx++, projectId);
            if (filterValue != null && !filterValue.isEmpty()) {
                ps.setString(idx++, filterValue);
            }
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                String name = rs.getString("group_name");
                String id = rs.getString("group_id");
                String status = rs.getString("status");
                int cnt = rs.getInt("cnt");
                Map<String, Object> row = grouped.computeIfAbsent(id, k -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("groupId", id);
                    m.put("groupName", name);
                    m.put("Passed", 0);
                    m.put("Failed", 0);
                    m.put("Blocked", 0);
                    m.put("Skipped", 0);
                    m.put("Untested", 0);
                    m.put("Retest", 0);
                    m.put("total", 0);
                    return m;
                });
                row.put(status, cnt);
                row.put("total", (int) row.get("total") + cnt);
            }
        }
        return new ArrayList<>(grouped.values());
    }

    private static List<Map<String, Object>> groupedStatusQueryMultiParam(Connection c, String sql, UUID projectId, String filterValue) throws SQLException {
        Map<String, Map<String, Object>> grouped = new LinkedHashMap<>();
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ps.setString(2, filterValue);
            ps.setString(3, "%" + filterValue + "%");
            ps.setString(4, "%" + filterValue + "%");
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                String name = rs.getString("group_name");
                String id = rs.getString("group_id");
                String status = rs.getString("status");
                int cnt = rs.getInt("cnt");
                Map<String, Object> row = grouped.computeIfAbsent(id, k -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("groupId", id);
                    m.put("groupName", name);
                    m.put("Passed", 0);
                    m.put("Failed", 0);
                    m.put("Blocked", 0);
                    m.put("Skipped", 0);
                    m.put("Untested", 0);
                    m.put("Retest", 0);
                    m.put("total", 0);
                    return m;
                });
                row.put(status, cnt);
                row.put("total", (int) row.get("total") + cnt);
            }
        }
        return new ArrayList<>(grouped.values());
    }

    /* ═══════════════════════════════════════════════════════════════════
       Requirement Traceability Matrix
       ═══════════════════════════════════════════════════════════════════ */
    public static void requirementMatrix(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        RbacService.requireProjectRole(userId, projectId);

        String sql = "SELECT tc.id AS tc_id, tc.external_id, tc.title AS tc_title, tc.priority, tc.status AS tc_status, " +
            "s.name AS suite_name, " +
            "cy.id AS run_id, cy.name AS run_name, cy.status AS run_status, " +
            "e.id AS exec_id, e.status AS exec_status, e.executed_at, " +
            "b.id AS bug_id, b.title AS bug_title, b.status AS bug_status, b.external_url AS bug_url " +
            "FROM testcases tc " +
            "LEFT JOIN suites s ON tc.suite_id = s.id " +
            "LEFT JOIN cycle_items ci ON ci.testcase_id = tc.id " +
            "LEFT JOIN cycles cy ON ci.cycle_id = cy.id AND cy.project_id = ? " +
            "LEFT JOIN executions e ON e.cycle_item_id = ci.id " +
            "LEFT JOIN bugs b ON b.testcase_id = tc.id AND b.cycle_id = cy.id " +
            "WHERE tc.project_id = ? " +
            "ORDER BY tc.external_id, cy.name";

        List<Map<String, Object>> rows = new ArrayList<>();

        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ps.setObject(2, projectId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("testcaseId", rs.getString("tc_id"));
                row.put("externalId", rs.getString("external_id"));
                row.put("testcaseTitle", rs.getString("tc_title"));
                row.put("priority", rs.getString("priority"));
                row.put("testcaseStatus", rs.getString("tc_status"));
                row.put("suiteName", rs.getString("suite_name"));
                row.put("runId", rs.getString("run_id"));
                row.put("runName", rs.getString("run_name"));
                row.put("runStatus", rs.getString("run_status"));
                row.put("executionId", rs.getString("exec_id"));
                row.put("executionStatus", rs.getString("exec_status"));
                String execAt = rs.getString("executed_at");
                row.put("executedAt", execAt);
                row.put("bugId", rs.getString("bug_id"));
                row.put("bugTitle", rs.getString("bug_title"));
                row.put("bugStatus", rs.getString("bug_status"));
                row.put("bugUrl", rs.getString("bug_url"));
                rows.add(row);
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }

        ctx.json(Map.of("rows", rows));
    }

    /* ═══════════════════════════════════════════════════════════════════
       Repository Summary
       ═══════════════════════════════════════════════════════════════════ */
    public static void repositorySummary(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        RbacService.requireProjectRole(userId, projectId);

        Map<String, Object> out = new LinkedHashMap<>();

        try (Connection c = Database.getDataSource().getConnection()) {
            out.put("totalTestCases", count(c, "SELECT COUNT(*) FROM testcases WHERE project_id = ?", projectId));

            // Test cases per suite
            List<Map<String, Object>> bySuite = new ArrayList<>();
            String suiteSql = "SELECT COALESCE(s.name, 'Unassigned') AS suite_name, COUNT(*) AS cnt " +
                "FROM testcases tc LEFT JOIN suites s ON tc.suite_id = s.id " +
                "WHERE tc.project_id = ? GROUP BY suite_name ORDER BY cnt DESC";
            try (PreparedStatement ps = c.prepareStatement(suiteSql)) {
                ps.setObject(1, projectId);
                ResultSet rs = ps.executeQuery();
                while (rs.next()) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("name", rs.getString("suite_name"));
                    row.put("count", rs.getInt("cnt"));
                    bySuite.add(row);
                }
            }
            out.put("bySuite", bySuite);

            // Test cases by status
            List<Map<String, Object>> byStatus = new ArrayList<>();
            String statusSql = "SELECT COALESCE(status, 'Unknown') AS status, COUNT(*) AS cnt " +
                "FROM testcases WHERE project_id = ? GROUP BY status ORDER BY cnt DESC";
            try (PreparedStatement ps = c.prepareStatement(statusSql)) {
                ps.setObject(1, projectId);
                ResultSet rs = ps.executeQuery();
                while (rs.next()) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("name", rs.getString("status"));
                    row.put("count", rs.getInt("cnt"));
                    byStatus.add(row);
                }
            }
            out.put("byStatus", byStatus);

            // Test cases added by date (last 30 days)
            List<Map<String, Object>> addedByDate = new ArrayList<>();
            String addedSql = "SELECT DATE(created_at) AS dt, COUNT(*) AS cnt " +
                "FROM testcases WHERE project_id = ? AND created_at >= NOW() - INTERVAL '30 days' " +
                "GROUP BY dt ORDER BY dt";
            try (PreparedStatement ps = c.prepareStatement(addedSql)) {
                ps.setObject(1, projectId);
                ResultSet rs = ps.executeQuery();
                while (rs.next()) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("date", rs.getString("dt"));
                    row.put("count", rs.getInt("cnt"));
                    addedByDate.add(row);
                }
            }
            out.put("addedByDate", addedByDate);

            // Test cases updated today
            out.put("updatedToday", count(c,
                "SELECT COUNT(*) FROM testcases WHERE project_id = ? AND DATE(updated_at) = CURRENT_DATE", projectId));

            // Test cases updated this week (Mon-Sun)
            out.put("updatedThisWeek", count(c,
                "SELECT COUNT(*) FROM testcases WHERE project_id = ? AND updated_at >= DATE_TRUNC('week', CURRENT_DATE)", projectId));

            // Test cases updated this month
            out.put("updatedThisMonth", count(c,
                "SELECT COUNT(*) FROM testcases WHERE project_id = ? AND updated_at >= DATE_TRUNC('month', CURRENT_DATE)", projectId));

            // Test cases by priority
            List<Map<String, Object>> byPriority = new ArrayList<>();
            String prioSql = "SELECT COALESCE(priority, 'Unknown') AS priority, COUNT(*) AS cnt " +
                "FROM testcases WHERE project_id = ? GROUP BY priority ORDER BY priority";
            try (PreparedStatement ps = c.prepareStatement(prioSql)) {
                ps.setObject(1, projectId);
                ResultSet rs = ps.executeQuery();
                while (rs.next()) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("name", rs.getString("priority"));
                    row.put("count", rs.getInt("cnt"));
                    byPriority.add(row);
                }
            }
            out.put("byPriority", byPriority);

        } catch (SQLException e) {
            throw new RuntimeException(e);
        }

        ctx.json(out);
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
