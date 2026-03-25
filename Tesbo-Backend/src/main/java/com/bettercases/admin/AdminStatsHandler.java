package com.bettercases.admin;

import com.bettercases.Database;
import io.javalin.http.Context;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Timestamp;
import java.util.*;

public final class AdminStatsHandler {

    public static void listCustomers(Context ctx) {
        SuperAdminService.requirePlatformAdmin(ctx);

        String sql = """
            SELECT
                o.id,
                o.name,
                o.slug,
                o.created_at,
                (SELECT COUNT(*) FROM organization_members om WHERE om.organization_id = o.id) AS member_count,
                (SELECT COUNT(*) FROM projects p WHERE p.organization_id = o.id AND p.archived_at IS NULL) AS project_count,
                COALESCE(tc_stats.total, 0) AS test_case_count,
                COALESCE(tc_stats.automated, 0) AS automated_count,
                tc_stats.last_activity
            FROM organizations o
            LEFT JOIN LATERAL (
                SELECT
                    COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE tc.automation_status = 'Automated' OR tc.automated_at IS NOT NULL) AS automated,
                    MAX(tc.updated_at) AS last_activity
                FROM testcases tc
                JOIN projects p ON tc.project_id = p.id
                WHERE p.organization_id = o.id AND p.archived_at IS NULL
            ) tc_stats ON true
            ORDER BY o.created_at DESC
            """;

        List<Map<String, Object>> customers = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql);
             ResultSet rs = ps.executeQuery()) {
            while (rs.next()) {
                Map<String, Object> org = new LinkedHashMap<>();
                org.put("id", rs.getObject("id").toString());
                org.put("name", rs.getString("name"));
                org.put("slug", rs.getString("slug"));
                org.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
                org.put("memberCount", rs.getInt("member_count"));
                org.put("projectCount", rs.getInt("project_count"));

                long totalCases = rs.getLong("test_case_count");
                long automatedCases = rs.getLong("automated_count");
                org.put("testCaseCount", totalCases);
                org.put("automatedCount", automatedCases);
                org.put("automationCoverage", totalCases > 0
                        ? Math.round(automatedCases * 1000.0 / totalCases) / 10.0
                        : 0.0);

                Timestamp lastActivity = rs.getTimestamp("last_activity");
                org.put("lastActivityAt", lastActivity != null ? lastActivity.toInstant().toString() : null);

                customers.add(org);
            }
        } catch (Exception e) {
            throw new RuntimeException(e);
        }

        // Build summary
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("totalOrganizations", customers.size());
        summary.put("totalMembers", customers.stream().mapToInt(c2 -> (int) c2.get("memberCount")).sum());
        summary.put("totalProjects", customers.stream().mapToInt(c2 -> (int) c2.get("projectCount")).sum());
        long totalTestCases = customers.stream().mapToLong(c2 -> (long) c2.get("testCaseCount")).sum();
        long totalAutomated = customers.stream().mapToLong(c2 -> (long) c2.get("automatedCount")).sum();
        summary.put("totalTestCases", totalTestCases);
        summary.put("totalAutomated", totalAutomated);
        summary.put("overallAutomationCoverage", totalTestCases > 0
                ? Math.round(totalAutomated * 1000.0 / totalTestCases) / 10.0
                : 0.0);

        ctx.json(Map.of("summary", summary, "customers", customers));
    }

    private AdminStatsHandler() {}
}
