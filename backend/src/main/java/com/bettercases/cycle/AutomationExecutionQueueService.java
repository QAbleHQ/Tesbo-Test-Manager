package com.bettercases.cycle;

import com.bettercases.Database;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class AutomationExecutionQueueService {
    private static final ObjectMapper mapper = new ObjectMapper();

    public static UUID createRunWithJobs(
            UUID cycleId,
            List<CycleAutomationRunService.ExecutionScriptRow> rows,
            int maxRetries,
            String startUrl,
            String executionProvider,
            int maxParallel,
            Map<String, Object> providerConfigSnapshot,
            Map<UUID, Long> estimatedDurationMsByExecution
    ) {
        try (Connection c = Database.getDataSource().getConnection()) {
            c.setAutoCommit(false);
            UUID runId;
            try (PreparedStatement ps = c.prepareStatement(
                    "INSERT INTO automation_runs (cycle_id, status, total_jobs, queued_jobs, started_at, execution_provider, max_parallel, provider_config_json) VALUES (?, 'running', ?, ?, now(), ?, ?, ?::jsonb) RETURNING id")) {
                ps.setObject(1, cycleId);
                ps.setInt(2, rows.size());
                ps.setInt(3, rows.size());
                ps.setString(4, executionProvider == null || executionProvider.isBlank() ? "default" : executionProvider);
                ps.setInt(5, Math.max(1, maxParallel));
                ps.setString(6, mapper.writeValueAsString(providerConfigSnapshot == null ? Map.of() : providerConfigSnapshot));
                ResultSet rs = ps.executeQuery();
                rs.next();
                runId = (UUID) rs.getObject("id");
            }
            int shardTotal = Math.max(1, Math.min(Math.max(1, maxParallel), countQueueable(rows)));
            Map<UUID, Integer> shardByExecution = assignShards(rows, shardTotal, estimatedDurationMsByExecution);
            String insertJobSql = """
                    INSERT INTO automation_jobs (
                      run_id, cycle_id, execution_id, testcase_title, testcase_external_id, script,
                      status, max_retries, start_url, execution_provider, provider_payload_json, shard_index, shard_total
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)
                    """;
            try (PreparedStatement ps = c.prepareStatement(insertJobSql)) {
                for (CycleAutomationRunService.ExecutionScriptRow row : rows) {
                    boolean queueable = row.script() != null && !row.script().isBlank();
                    int shardIndex = queueable ? shardByExecution.getOrDefault(row.executionId(), 1) : 1;
                    ps.setObject(1, runId);
                    ps.setObject(2, cycleId);
                    ps.setObject(3, row.executionId());
                    ps.setString(4, row.title());
                    ps.setString(5, row.externalId());
                    ps.setString(6, row.script());
                    ps.setString(7, queueable ? "queued" : "manual");
                    ps.setInt(8, Math.max(0, maxRetries));
                    ps.setString(9, startUrl);
                    ps.setString(10, executionProvider == null || executionProvider.isBlank() ? "default" : executionProvider);
                    ps.setString(11, mapper.writeValueAsString(providerConfigSnapshot == null ? Map.of() : providerConfigSnapshot));
                    ps.setInt(12, shardIndex);
                    ps.setInt(13, shardTotal);
                    ps.addBatch();
                }
                ps.executeBatch();
            }
            // Immediately count non-runnable jobs as manual-required.
            try (PreparedStatement ps = c.prepareStatement("""
                    UPDATE automation_runs
                    SET failed_jobs = (
                      SELECT COUNT(*) FROM automation_jobs WHERE run_id = ? AND status = 'failed'
                    ),
                    queued_jobs = (
                      SELECT COUNT(*) FROM automation_jobs WHERE run_id = ? AND status = 'queued'
                    ),
                    updated_at = now()
                    WHERE id = ?
                    """)) {
                ps.setObject(1, runId);
                ps.setObject(2, runId);
                ps.setObject(3, runId);
                ps.executeUpdate();
            }
            c.commit();
            recomputeRun(runId);
            return runId;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static List<Map<String, Object>> listQueueableJobs(UUID runId) {
        String sql = """
                SELECT id, run_id, cycle_id, execution_id, script, max_retries, start_url, execution_provider, provider_payload_json, shard_index, shard_total
                FROM automation_jobs
                WHERE run_id = ? AND status = 'queued' AND script IS NOT NULL AND btrim(script) <> ''
                ORDER BY created_at ASC
                """;
        List<Map<String, Object>> out = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, runId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("jobId", rs.getObject("id").toString());
                row.put("runId", rs.getObject("run_id").toString());
                row.put("cycleId", rs.getObject("cycle_id").toString());
                row.put("executionId", rs.getObject("execution_id").toString());
                row.put("script", rs.getString("script"));
                row.put("maxRetries", rs.getInt("max_retries"));
                row.put("startUrl", rs.getString("start_url"));
                row.put("executionProvider", rs.getString("execution_provider"));
                row.put("providerPayload", parseJsonObject(rs.getString("provider_payload_json")));
                row.put("shardIndex", rs.getInt("shard_index"));
                row.put("shardTotal", rs.getInt("shard_total"));
                out.add(row);
            }
            return out;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static void markJobEnqueued(UUID jobId, String queueJobId) {
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(
                     "UPDATE automation_jobs SET queue_job_id = ?, updated_at = now() WHERE id = ?")) {
            ps.setString(1, queueJobId);
            ps.setObject(2, jobId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static Map<String, Object> getJob(UUID jobId) {
        String sql = """
                SELECT id, run_id, cycle_id, execution_id, status, script, max_retries, execution_provider, shard_index, shard_total
                FROM automation_jobs
                WHERE id = ?
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, jobId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) throw new io.javalin.http.NotFoundResponse();
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("jobId", rs.getObject("id").toString());
            out.put("runId", rs.getObject("run_id").toString());
            out.put("cycleId", rs.getObject("cycle_id").toString());
            out.put("executionId", rs.getObject("execution_id").toString());
            out.put("status", rs.getString("status"));
            out.put("script", rs.getString("script"));
            out.put("maxRetries", rs.getInt("max_retries"));
            out.put("executionProvider", rs.getString("execution_provider"));
            out.put("shardIndex", rs.getInt("shard_index"));
            out.put("shardTotal", rs.getInt("shard_total"));
            return out;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static void markJobStarted(UUID jobId, String workerId, int attempt) {
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("""
                     UPDATE automation_jobs
                     SET status = 'running',
                         worker_id = ?,
                         retry_count = ?,
                         started_at = COALESCE(started_at, now()),
                         last_heartbeat_at = now(),
                         updated_at = now()
                     WHERE id = ?
                     """)) {
            ps.setString(1, workerId);
            ps.setInt(2, Math.max(0, attempt));
            ps.setObject(3, jobId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        recomputeRunByJob(jobId);
    }

    public static void heartbeat(UUID jobId, String workerId) {
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("""
                     UPDATE automation_jobs
                     SET worker_id = COALESCE(?, worker_id),
                         last_heartbeat_at = now(),
                         updated_at = now()
                     WHERE id = ?
                     """)) {
            ps.setString(1, workerId);
            ps.setObject(2, jobId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static void markJobCompleted(UUID jobId) {
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("""
                     UPDATE automation_jobs
                     SET status = 'passed',
                         ended_at = now(),
                         last_heartbeat_at = now(),
                         updated_at = now()
                     WHERE id = ?
                     """)) {
            ps.setObject(1, jobId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        recomputeRunByJob(jobId);
    }

    public static void markJobFailed(UUID jobId, String errorMessage, boolean willRetry, int attempt) {
        String nextStatus = willRetry ? "queued" : "failed";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("""
                     UPDATE automation_jobs
                     SET status = ?,
                         error_message = ?,
                         retry_count = ?,
                         ended_at = CASE WHEN ? = 'failed' THEN now() ELSE ended_at END,
                         last_heartbeat_at = now(),
                         updated_at = now()
                     WHERE id = ?
                     """)) {
            ps.setString(1, nextStatus);
            ps.setString(2, errorMessage);
            ps.setInt(3, Math.max(0, attempt));
            ps.setString(4, nextStatus);
            ps.setObject(5, jobId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        recomputeRunByJob(jobId);
    }

    public static Map<String, Object> snapshot(UUID cycleId, UUID runId) {
        Map<String, Object> run = fetchRun(cycleId, runId);
        List<Map<String, Object>> items = fetchRunItems(runId);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("runId", run.get("id"));
        out.put("cycleId", run.get("cycleId"));
        out.put("status", run.get("status"));
        out.put("startedAt", run.get("startedAt"));
        out.put("endedAt", run.get("endedAt"));
        out.put("currentExecutionId", findCurrentExecutionId(items));
        out.put("totalCases", run.get("totalJobs"));
        out.put("completed", run.get("completedJobs"));
        out.put("passed", run.get("passedJobs"));
        out.put("failed", run.get("failedJobs"));
        out.put("executionProvider", run.get("executionProvider"));
        out.put("maxParallel", run.get("maxParallel"));
        out.put("error", run.get("errorMessage"));
        out.put("items", items);
        return out;
    }

    private static String findCurrentExecutionId(List<Map<String, Object>> items) {
        for (Map<String, Object> item : items) {
            if ("running".equals(item.get("status"))) {
                return String.valueOf(item.get("executionId"));
            }
        }
        return null;
    }

    public static boolean exists(UUID cycleId, UUID runId) {
        String sql = "SELECT 1 FROM automation_runs WHERE id = ? AND cycle_id = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, runId);
            ps.setObject(2, cycleId);
            ResultSet rs = ps.executeQuery();
            return rs.next();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static UUID findActiveRunId(UUID cycleId) {
        String sql = """
                SELECT id
                FROM automation_runs
                WHERE cycle_id = ? AND status = 'running'
                ORDER BY started_at DESC
                LIMIT 1
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, cycleId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) {
                return (UUID) rs.getObject("id");
            }
            return null;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static UUID findLatestRunId(UUID cycleId) {
        String sql = """
                SELECT id
                FROM automation_runs
                WHERE cycle_id = ?
                ORDER BY created_at DESC
                LIMIT 1
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, cycleId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) {
                return (UUID) rs.getObject("id");
            }
            return null;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static int countActiveRunsForProject(UUID projectId) {
        String sql = """
                SELECT COUNT(*)
                FROM automation_runs ar
                JOIN cycles c ON c.id = ar.cycle_id
                WHERE c.project_id = ?
                  AND ar.status = 'running'
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) return 0;
            return rs.getInt(1);
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static int countQueuedJobsForProject(UUID projectId) {
        String sql = """
                SELECT COUNT(*)
                FROM automation_jobs aj
                JOIN cycles c ON c.id = aj.cycle_id
                WHERE c.project_id = ?
                  AND aj.status = 'queued'
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) return 0;
            return rs.getInt(1);
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static Map<String, Object> queueLoadSnapshot() {
        String sql = """
                SELECT
                  COUNT(*) FILTER (WHERE status = 'queued') AS queued_jobs,
                  COUNT(*) FILTER (WHERE status = 'running') AS running_jobs,
                  COUNT(*) FILTER (WHERE status IN ('failed','cancelled')) AS errored_jobs
                FROM automation_jobs
                """;
        String activeRunsSql = """
                SELECT COUNT(*) FROM automation_runs WHERE status = 'running'
                """;
        try (Connection c = Database.getDataSource().getConnection()) {
            Map<String, Object> out = new LinkedHashMap<>();
            try (PreparedStatement ps = c.prepareStatement(sql)) {
                ResultSet rs = ps.executeQuery();
                if (rs.next()) {
                    out.put("queuedJobs", rs.getInt("queued_jobs"));
                    out.put("runningJobs", rs.getInt("running_jobs"));
                    out.put("erroredJobs", rs.getInt("errored_jobs"));
                }
            }
            try (PreparedStatement ps = c.prepareStatement(activeRunsSql)) {
                ResultSet rs = ps.executeQuery();
                out.put("activeRuns", rs.next() ? rs.getInt(1) : 0);
            }
            return out;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static Map<UUID, Long> estimateExecutionDurationsMillisForRows(List<CycleAutomationRunService.ExecutionScriptRow> rows) {
        if (rows == null || rows.isEmpty()) return Map.of();
        String sql = """
                SELECT e.id AS execution_id,
                       COALESCE((
                         SELECT AVG(EXTRACT(EPOCH FROM (ear.ended_at - ear.started_at)) * 1000)::bigint
                         FROM execution_automation_reports ear
                         JOIN executions pe ON pe.id = ear.execution_id
                         JOIN cycle_items pci ON pci.id = pe.cycle_item_id
                         WHERE pci.testcase_id = ci.testcase_id
                           AND ear.status IN ('passed', 'failed')
                       ), 90000) AS estimated_duration_ms
                FROM executions e
                JOIN cycle_items ci ON ci.id = e.cycle_item_id
                WHERE e.id = ANY (?::uuid[])
                """;
        java.sql.Array idsArray = null;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            UUID[] ids = rows.stream().map(CycleAutomationRunService.ExecutionScriptRow::executionId).toArray(UUID[]::new);
            idsArray = c.createArrayOf("uuid", ids);
            ps.setArray(1, idsArray);
            ResultSet rs = ps.executeQuery();
            Map<UUID, Long> out = new HashMap<>();
            while (rs.next()) {
                out.put((UUID) rs.getObject("execution_id"), Math.max(15_000L, rs.getLong("estimated_duration_ms")));
            }
            return out;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        } finally {
            if (idsArray != null) {
                try {
                    idsArray.free();
                } catch (SQLException ignored) {
                }
            }
        }
    }

    public static void cancelRun(UUID cycleId, UUID runId, String reason) {
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("""
                     UPDATE automation_runs
                     SET status = 'cancelled',
                         error_message = ?,
                         ended_at = now(),
                         updated_at = now()
                     WHERE id = ? AND cycle_id = ? AND status = 'running'
                     """)) {
            ps.setString(1, reason);
            ps.setObject(2, runId);
            ps.setObject(3, cycleId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static int recoverStuckRunningJobs(int staleMinutes) {
        int safeMinutes = Math.max(1, staleMinutes);
        String sql = """
                UPDATE automation_jobs
                SET status = 'queued',
                    error_message = COALESCE(error_message, 'Recovered from stale running state'),
                    retry_count = retry_count + 1,
                    updated_at = now()
                WHERE status = 'running'
                  AND (last_heartbeat_at IS NULL OR last_heartbeat_at < now() - (?::text || ' minutes')::interval)
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, String.valueOf(safeMinutes));
            int changed = ps.executeUpdate();
            if (changed > 0) {
                recomputeAllRunningRuns();
            }
            return changed;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static Map<String, Object> fetchRun(UUID cycleId, UUID runId) {
        String sql = """
                SELECT id, cycle_id, status, total_jobs, completed_jobs, passed_jobs, failed_jobs, error_message, started_at, ended_at, execution_provider, max_parallel
                FROM automation_runs
                WHERE id = ? AND cycle_id = ?
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, runId);
            ps.setObject(2, cycleId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) throw new io.javalin.http.NotFoundResponse();
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("id", rs.getObject("id").toString());
            out.put("cycleId", rs.getObject("cycle_id").toString());
            out.put("status", rs.getString("status"));
            out.put("totalJobs", rs.getInt("total_jobs"));
            out.put("completedJobs", rs.getInt("completed_jobs"));
            out.put("passedJobs", rs.getInt("passed_jobs"));
            out.put("failedJobs", rs.getInt("failed_jobs"));
            out.put("errorMessage", rs.getString("error_message"));
            out.put("executionProvider", rs.getString("execution_provider"));
            out.put("maxParallel", rs.getInt("max_parallel"));
            Timestamp startedAt = rs.getTimestamp("started_at");
            Timestamp endedAt = rs.getTimestamp("ended_at");
            out.put("startedAt", startedAt != null ? startedAt.toInstant().toString() : null);
            out.put("endedAt", endedAt != null ? endedAt.toInstant().toString() : null);
            return out;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static List<Map<String, Object>> fetchRunItems(UUID runId) {
        String sql = """
                SELECT id, execution_id, testcase_title, testcase_external_id, status, worker_id, error_message, shard_index, shard_total, execution_provider
                FROM automation_jobs
                WHERE run_id = ?
                ORDER BY created_at ASC
                """;
        List<Map<String, Object>> out = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, runId);
            ResultSet rs = ps.executeQuery();
            int index = 0;
            while (rs.next()) {
                index++;
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("jobId", rs.getObject("id").toString());
                item.put("executionId", rs.getObject("execution_id").toString());
                item.put("title", rs.getString("testcase_title"));
                item.put("externalId", rs.getString("testcase_external_id"));
                item.put("status", normalizeItemStatus(rs.getString("status")));
                item.put("index", index);
                item.put("workerId", rs.getString("worker_id"));
                item.put("message", rs.getString("error_message"));
                item.put("shardIndex", rs.getInt("shard_index"));
                item.put("shardTotal", rs.getInt("shard_total"));
                item.put("executionProvider", rs.getString("execution_provider"));
                out.add(item);
            }
            return out;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static String normalizeItemStatus(String status) {
        if (status == null) return "queued";
        return switch (status) {
            case "passed" -> "passed";
            case "failed" -> "failed";
            case "running" -> "running";
            case "cancelled" -> "cancelled";
            case "manual" -> "manual";
            default -> "queued";
        };
    }

    private static void recomputeRunByJob(UUID jobId) {
        String sql = "SELECT run_id FROM automation_jobs WHERE id = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, jobId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) {
                recomputeRun((UUID) rs.getObject("run_id"));
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static void recomputeAllRunningRuns() {
        String sql = "SELECT id FROM automation_runs WHERE status = 'running'";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                recomputeRun((UUID) rs.getObject("id"));
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static void recomputeRun(UUID runId) {
        String sql = """
                UPDATE automation_runs r
                SET queued_jobs = c.queued_jobs,
                    completed_jobs = c.completed_jobs,
                    passed_jobs = c.passed_jobs,
                    failed_jobs = c.failed_jobs,
                    cancelled_jobs = c.cancelled_jobs,
                    status = CASE
                        WHEN r.status = 'cancelled' THEN r.status
                        WHEN c.completed_jobs >= r.total_jobs THEN CASE WHEN c.failed_jobs > 0 THEN 'failed' ELSE 'completed' END
                        ELSE 'running'
                    END,
                    ended_at = CASE
                        WHEN r.status = 'cancelled' THEN r.ended_at
                        WHEN c.completed_jobs >= r.total_jobs THEN COALESCE(r.ended_at, now())
                        ELSE NULL
                    END,
                    updated_at = now()
                FROM (
                    SELECT run_id,
                           COUNT(*) FILTER (WHERE status = 'queued') AS queued_jobs,
                           COUNT(*) FILTER (WHERE status IN ('passed', 'failed', 'cancelled', 'manual')) AS completed_jobs,
                           COUNT(*) FILTER (WHERE status = 'passed') AS passed_jobs,
                           COUNT(*) FILTER (WHERE status = 'failed') AS failed_jobs,
                           COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_jobs
                    FROM automation_jobs
                    WHERE run_id = ?
                    GROUP BY run_id
                ) c
                WHERE r.id = c.run_id
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, runId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static int countQueueable(List<CycleAutomationRunService.ExecutionScriptRow> rows) {
        int count = 0;
        for (CycleAutomationRunService.ExecutionScriptRow row : rows) {
            if (row.script() != null && !row.script().isBlank()) {
                count++;
            }
        }
        return count;
    }

    private static Map<UUID, Integer> assignShards(
            List<CycleAutomationRunService.ExecutionScriptRow> rows,
            int shardTotal,
            Map<UUID, Long> estimatedDurationMsByExecution
    ) {
        if (rows == null || rows.isEmpty() || shardTotal <= 1) {
            Map<UUID, Integer> flat = new HashMap<>();
            if (rows != null) {
                for (CycleAutomationRunService.ExecutionScriptRow row : rows) {
                    if (row.script() != null && !row.script().isBlank()) {
                        flat.put(row.executionId(), 1);
                    }
                }
            }
            return flat;
        }
        long[] shardLoad = new long[shardTotal];
        List<CycleAutomationRunService.ExecutionScriptRow> queueable = rows.stream()
                .filter(r -> r.script() != null && !r.script().isBlank())
                .sorted(Comparator.comparingLong(
                        (CycleAutomationRunService.ExecutionScriptRow row) ->
                                estimatedDurationMsByExecution == null
                                        ? 90_000L
                                        : estimatedDurationMsByExecution.getOrDefault(row.executionId(), 90_000L)
                ).reversed())
                .toList();
        Map<UUID, Integer> out = new HashMap<>();
        for (CycleAutomationRunService.ExecutionScriptRow row : queueable) {
            int chosenShard = 0;
            for (int i = 1; i < shardTotal; i++) {
                if (shardLoad[i] < shardLoad[chosenShard]) {
                    chosenShard = i;
                }
            }
            long estimate = estimatedDurationMsByExecution == null
                    ? 90_000L
                    : estimatedDurationMsByExecution.getOrDefault(row.executionId(), 90_000L);
            shardLoad[chosenShard] += Math.max(15_000L, estimate);
            out.put(row.executionId(), chosenShard + 1);
        }
        return out;
    }

    private static Map<String, Object> parseJsonObject(String raw) {
        if (raw == null || raw.isBlank()) return Map.of();
        try {
            return mapper.readValue(raw, new TypeReference<>() {});
        } catch (Exception ignored) {
            return Map.of();
        }
    }

    private AutomationExecutionQueueService() {}
}
