package com.bettercases.testexecution;

import com.bettercases.Database;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.LinkedHashMap;
import java.util.Map;

public final class AutomationQueueMetricsService {
    public static Map<String, Object> currentRunMetrics() {
        String sql = """
                SELECT
                  COUNT(*) FILTER (WHERE status = 'running') AS running_runs,
                  COUNT(*) FILTER (WHERE status = 'completed') AS completed_runs,
                  COUNT(*) FILTER (WHERE status = 'failed') AS failed_runs,
                  COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_runs
                FROM automation_runs
                """;
        String jobSql = """
                SELECT
                  COUNT(*) FILTER (WHERE status = 'queued') AS queued_jobs,
                  COUNT(*) FILTER (WHERE status = 'running') AS running_jobs,
                  COUNT(*) FILTER (WHERE status = 'passed') AS passed_jobs,
                  COUNT(*) FILTER (WHERE status = 'failed') AS failed_jobs,
                  COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_jobs
                FROM automation_jobs
                """;
        Map<String, Object> out = new LinkedHashMap<>();
        try (Connection c = Database.getDataSource().getConnection()) {
            try (PreparedStatement ps = c.prepareStatement(sql)) {
                ResultSet rs = ps.executeQuery();
                if (rs.next()) {
                    out.put("runningRuns", rs.getInt("running_runs"));
                    out.put("completedRuns", rs.getInt("completed_runs"));
                    out.put("failedRuns", rs.getInt("failed_runs"));
                    out.put("cancelledRuns", rs.getInt("cancelled_runs"));
                }
            }
            try (PreparedStatement ps = c.prepareStatement(jobSql)) {
                ResultSet rs = ps.executeQuery();
                if (rs.next()) {
                    out.put("queuedJobs", rs.getInt("queued_jobs"));
                    out.put("runningJobs", rs.getInt("running_jobs"));
                    out.put("passedJobs", rs.getInt("passed_jobs"));
                    out.put("failedJobs", rs.getInt("failed_jobs"));
                    out.put("cancelledJobs", rs.getInt("cancelled_jobs"));
                }
            }
            return out;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private AutomationQueueMetricsService() {}
}
