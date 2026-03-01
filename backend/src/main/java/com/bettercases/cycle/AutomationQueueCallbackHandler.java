package com.bettercases.cycle;

import com.bettercases.Config;
import io.javalin.http.Context;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class AutomationQueueCallbackHandler {
    private static boolean isAuthorized(Context ctx) {
        if (Config.AUTOMATION_QUEUE_SHARED_TOKEN.isBlank()) return true;
        String token = ctx.header("x-automation-token");
        return Config.AUTOMATION_QUEUE_SHARED_TOKEN.equals(token);
    }

    public static void start(Context ctx) {
        if (!isAuthorized(ctx)) {
            ctx.status(401).json(Map.of("error", "Unauthorized"));
            return;
        }
        UUID jobId = UUID.fromString(ctx.pathParam("jobId"));
        StartBody body = ctx.bodyAsClass(StartBody.class);
        if (body == null) body = new StartBody();
        AutomationExecutionQueueService.markJobStarted(jobId, body.workerId, body.attempt);
        ctx.status(204);
    }

    public static void heartbeat(Context ctx) {
        if (!isAuthorized(ctx)) {
            ctx.status(401).json(Map.of("error", "Unauthorized"));
            return;
        }
        UUID jobId = UUID.fromString(ctx.pathParam("jobId"));
        HeartbeatBody body = ctx.bodyAsClass(HeartbeatBody.class);
        if (body == null) body = new HeartbeatBody();
        AutomationExecutionQueueService.heartbeat(jobId, body.workerId);
        ctx.status(204);
    }

    public static void complete(Context ctx) {
        if (!isAuthorized(ctx)) {
            ctx.status(401).json(Map.of("error", "Unauthorized"));
            return;
        }
        UUID jobId = UUID.fromString(ctx.pathParam("jobId"));
        CompleteBody body = ctx.bodyAsClass(CompleteBody.class);
        if (body == null) body = new CompleteBody();
        Map<String, Object> job = AutomationExecutionQueueService.getJob(jobId);
        UUID cycleId = UUID.fromString(String.valueOf(job.get("cycleId")));
        UUID executionId = UUID.fromString(String.valueOf(job.get("executionId")));
        boolean ok = "passed".equalsIgnoreCase(body.status);
        String markStatus = ok ? "Passed" : "Failed";
        String resultText = ok ? "Automated run passed." : ("Automated run failed: " + (body.errorMessage == null ? "Unknown error" : body.errorMessage));
        updateExecution(executionId, markStatus, resultText);
        List<Map<String, Object>> logs = body.logs == null ? List.of() : body.logs;
        ExecutionAutomationReportService.upsert(
                cycleId,
                executionId,
                ok ? "passed" : "failed",
                body.startedAt != null ? body.startedAt : Instant.now().toString(),
                Instant.now().toString(),
                logs,
                body.videoPath,
                body.screenshotPath,
                ok ? null : body.errorMessage
        );
        if (ok) {
            AutomationExecutionQueueService.markJobCompleted(jobId);
        } else {
            AutomationExecutionQueueService.markJobFailed(jobId, body.errorMessage, false, body.attempt);
        }
        ctx.status(204);
    }

    public static void fail(Context ctx) {
        if (!isAuthorized(ctx)) {
            ctx.status(401).json(Map.of("error", "Unauthorized"));
            return;
        }
        UUID jobId = UUID.fromString(ctx.pathParam("jobId"));
        FailBody body = ctx.bodyAsClass(FailBody.class);
        if (body == null) body = new FailBody();
        String message = body.errorMessage == null || body.errorMessage.isBlank() ? "Worker failure" : body.errorMessage;
        AutomationExecutionQueueService.markJobFailed(jobId, message, body.willRetry, body.attempt);
        if (!body.willRetry) {
            Map<String, Object> job = AutomationExecutionQueueService.getJob(jobId);
            UUID executionId = UUID.fromString(String.valueOf(job.get("executionId")));
            updateExecution(executionId, "Failed", "Automated run failed: " + message);
        }
        ctx.status(204);
    }

    private static void updateExecution(UUID executionId, String status, String actualResult) {
        String sql = """
                UPDATE executions
                SET status = ?, actual_result = ?, executed_at = now(), updated_at = now()
                WHERE id = ?
                """;
        try (java.sql.Connection c = com.bettercases.Database.getDataSource().getConnection();
             java.sql.PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, status);
            ps.setString(2, actualResult);
            ps.setObject(3, executionId);
            ps.executeUpdate();
        } catch (java.sql.SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static class StartBody {
        public String workerId;
        public int attempt;
    }

    public static class HeartbeatBody {
        public String workerId;
    }

    public static class CompleteBody {
        public String status;
        public String startedAt;
        public String errorMessage;
        public String videoPath;
        public String screenshotPath;
        public List<Map<String, Object>> logs;
        public int attempt;
    }

    public static class FailBody {
        public String errorMessage;
        public boolean willRetry;
        public int attempt;
    }

    private AutomationQueueCallbackHandler() {}
}
