package com.bettercases.testexecution;

import com.bettercases.Config;
import com.bettercases.Database;
import com.bettercases.cycle.ExecutionAutomationReportService;
import io.javalin.http.Context;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Receives webhook callbacks from TesboX-Executions.
 * Updates the local TesboX executions table with results.
 */
public final class ExecutionServiceWebhookHandler {

    public static void handle(Context ctx) {
        if (!verifySignature(ctx)) {
            ctx.status(401).json(Map.of("error", "Invalid webhook signature"));
            return;
        }

        WebhookPayload payload = ctx.bodyAsClass(WebhookPayload.class);
        if (payload == null || payload.event == null) {
            ctx.status(400).json(Map.of("error", "Invalid payload"));
            return;
        }

        switch (payload.event) {
            case "job.completed" -> handleJobCompleted(payload);
            case "job.failed" -> handleJobFailed(payload);
            case "run.completed", "run.failed", "run.cancelled" -> handleRunFinished(payload);
            default -> { /* ignore unknown events */ }
        }

        ctx.status(204);
    }

    private static void handleJobCompleted(WebhookPayload payload) {
        if (payload.externalJobRef == null) return;
        UUID executionId = parseUuid(payload.externalJobRef);
        if (executionId == null) return;

        boolean ok = "passed".equalsIgnoreCase(payload.status);
        String markStatus = ok ? "Passed" : "Failed";
        String resultText = ok
                ? "Automated run passed."
                : "Automated run failed: " + (payload.errorMessage != null ? payload.errorMessage : "Unknown error");

        updateExecution(executionId, markStatus, resultText);

        UUID cycleId = parseUuid(payload.externalRef);
        if (cycleId != null) {
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> logs = payload.logs instanceof List<?> l
                    ? (List<Map<String, Object>>) l
                    : List.of();
            ExecutionAutomationReportService.upsert(
                    cycleId,
                    executionId,
                    ok ? "passed" : "failed",
                    payload.startedAt != null ? payload.startedAt : Instant.now().toString(),
                    Instant.now().toString(),
                    logs,
                    payload.videoPath,
                    payload.screenshotPath,
                    payload.tracePath,
                    ok ? null : payload.errorMessage
            );
        }
    }

    private static void handleJobFailed(WebhookPayload payload) {
        if (payload.externalJobRef == null) return;
        UUID executionId = parseUuid(payload.externalJobRef);
        if (executionId == null) return;

        String message = payload.errorMessage != null ? payload.errorMessage : "Automated run failed";
        updateExecution(executionId, "Failed", "Automated run failed: " + message);

        UUID cycleId = parseUuid(payload.externalRef);
        if (cycleId != null) {
            ExecutionAutomationReportService.upsert(
                    cycleId,
                    executionId,
                    "failed",
                    Instant.now().toString(),
                    Instant.now().toString(),
                    List.of(),
                    null,
                    null,
                    null,
                    message
            );
        }
    }

    private static void handleRunFinished(WebhookPayload payload) {
        // Run-level events are informational; job-level events update the executions.
    }

    private static void updateExecution(UUID executionId, String status, String actualResult) {
        String sql = """
                UPDATE executions
                SET status = ?, actual_result = ?, executed_at = now(), updated_at = now()
                WHERE id = ?
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, status);
            ps.setString(2, actualResult);
            ps.setObject(3, executionId);
            ps.executeUpdate();
        } catch (java.sql.SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static boolean verifySignature(Context ctx) {
        String secret = Config.EXECUTION_SERVICE_WEBHOOK_SECRET;
        if (secret == null || secret.isBlank()) {
            // Backward-compatible fallback for setups using shared agent token auth.
            String expectedToken = Config.EXECUTION_SERVICE_API_KEY;
            String token = ctx.header("x-agent-token");
            if (expectedToken != null && !expectedToken.isBlank() && token != null && !token.isBlank()) {
                return MessageDigest.isEqual(
                        expectedToken.getBytes(StandardCharsets.UTF_8),
                        token.getBytes(StandardCharsets.UTF_8)
                );
            }
            System.err.println("WARN: EXECUTION_SERVICE_WEBHOOK_SECRET is not configured and x-agent-token validation failed.");
            return false;
        }

        String signature = ctx.header("x-webhook-signature");
        if (signature == null || signature.isBlank()) return false;

        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] hash = mac.doFinal(ctx.body().getBytes(StandardCharsets.UTF_8));
            String expected = bytesToHex(hash);
            return MessageDigest.isEqual(
                    expected.toLowerCase().getBytes(StandardCharsets.UTF_8),
                    signature.toLowerCase().getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            return false;
        }
    }

    private static String bytesToHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    private static UUID parseUuid(String value) {
        if (value == null || value.isBlank()) return null;
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    public static class WebhookPayload {
        public String event;
        public String runId;
        public String jobId;
        public String externalRef;
        public String externalJobRef;
        public String status;
        public String errorMessage;
        public String startedAt;
        public String videoPath;
        public String screenshotPath;
        public String tracePath;
        public Object logs;
        public String timestamp;
    }

    private ExecutionServiceWebhookHandler() {}
}
