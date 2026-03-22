package com.bettercases.testexecution;

import com.bettercases.Config;
import com.bettercases.automation.AutomationAgentClient;
import io.javalin.http.Context;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Token-authenticated snapshot for operators and autoscalers (HPA, etc.).
 * Requires {@link Config#AUTOMATION_QUEUE_SHARED_TOKEN} and header {@code x-automation-token}.
 */
public final class AutomationInternalMetricsHandler {

    public static void executionPoolSnapshot(Context ctx) {
        if (Config.AUTOMATION_QUEUE_SHARED_TOKEN.isBlank()) {
            ctx.status(503).json(Map.of("error", "AUTOMATION_QUEUE_SHARED_TOKEN is not configured"));
            return;
        }
        String token = ctx.header("x-automation-token");
        if (token == null || !Config.AUTOMATION_QUEUE_SHARED_TOKEN.equals(token)) {
            ctx.status(401).json(Map.of("error", "Unauthorized"));
            return;
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("db", AutomationQueueMetricsService.currentRunMetrics());
        body.put("pendingBullDispatch", AutomationExecutionQueueService.countGlobalPendingBullDispatch());
        body.put("load", AutomationExecutionQueueService.queueLoadSnapshot());
        body.put("autoscaling", AutomationQueueAutoscalingService.recommendWorkers());
        try {
            body.put("redisQueue", AutomationAgentClient.queueStats());
        } catch (Exception e) {
            body.put("redisQueue", Map.of("error", e.getMessage()));
        }
        ctx.json(body);
    }

    private AutomationInternalMetricsHandler() {}
}
