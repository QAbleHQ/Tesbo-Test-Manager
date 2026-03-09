package com.bettercases.cycle;

import com.bettercases.automation.AutomationAgentClient;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class AutomationExecutionOrchestratorService {
    public static Map<String, Object> enqueueRun(
            UUID cycleId,
            List<CycleAutomationRunService.ExecutionScriptRow> rows,
            CycleAutomationRunService.CycleAutomationConfig automationConfig,
            int maxRetries
    ) {
        UUID activeRun = AutomationExecutionQueueService.findActiveRunId(cycleId);
        if (activeRun != null) {
            throw new io.javalin.http.ConflictResponse("An automated run is already in progress for this test run.");
        }
        UUID runId = AutomationExecutionQueueService.createRunWithJobs(
                cycleId,
                rows,
                maxRetries,
                automationConfig.startUrl(),
                automationConfig.executionProvider(),
                automationConfig.maxParallel(),
                automationConfig.providerConfig()
        );
        List<Map<String, Object>> jobs = AutomationExecutionQueueService.listQueueableJobs(runId);
        for (Map<String, Object> job : jobs) {
            UUID jobId = UUID.fromString(String.valueOf(job.get("jobId")));
            try {
                Map<String, Object> payload = new LinkedHashMap<>();
                payload.put("jobId", String.valueOf(job.get("jobId")));
                payload.put("runId", String.valueOf(job.get("runId")));
                payload.put("cycleId", String.valueOf(job.get("cycleId")));
                payload.put("executionId", String.valueOf(job.get("executionId")));
                payload.put("script", String.valueOf(job.get("script")));
                payload.put("startUrl", job.get("startUrl"));
                payload.put("maxRetries", job.get("maxRetries"));
                payload.put("executionProvider", job.get("executionProvider"));
                payload.put("providerPayload", job.get("providerPayload"));
                payload.put("shardIndex", job.get("shardIndex"));
                payload.put("shardTotal", job.get("shardTotal"));
                payload.put("modelProvider", automationConfig.modelProvider());
                payload.put("modelApiKey", automationConfig.modelApiKey());
                payload.put("model", automationConfig.model());
                payload.put("browserbaseApiKey", automationConfig.browserbaseApiKey());
                payload.put("browserbaseProjectId", automationConfig.browserbaseProjectId());
                payload.put("cacheScope", String.valueOf(cycleId) + "/" + String.valueOf(job.get("executionId")));
                Map<String, Object> queued = AutomationAgentClient.enqueueAutomationJob(payload);
                String queueJobId = queued.get("queueJobId") instanceof String s ? s : String.valueOf(job.get("jobId"));
                AutomationExecutionQueueService.markJobEnqueued(jobId, queueJobId);
            } catch (Exception e) {
                AutomationExecutionQueueService.markJobFailed(jobId, "Queue enqueue failed: " + e.getMessage(), false, 0);
            }
        }
        return Map.of(
                "runId", runId.toString(),
                "cycleId", cycleId.toString(),
                "status", "running",
                "totalCases", rows.size(),
                "executionProvider", automationConfig.executionProvider(),
                "maxParallel", automationConfig.maxParallel()
        );
    }

    private AutomationExecutionOrchestratorService() {}
}
