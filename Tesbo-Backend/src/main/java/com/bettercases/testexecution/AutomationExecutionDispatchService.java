package com.bettercases.testexecution;

import com.bettercases.Config;
import com.bettercases.automation.AutomationAgentClient;
import com.bettercases.cycle.CycleService;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Pushes automation jobs to Redis/Bull only when per-project and per-run concurrency allows.
 */
public final class AutomationExecutionDispatchService {

    public static void dispatchAvailableSlots(UUID projectId) {
        if (projectId == null) {
            return;
        }
        int maxProject = ProjectAutomationConcurrencyService.effectiveConcurrentJobLimit(projectId);
        int batchSize = Math.max(1, Config.AUTOMATION_QUEUE_DISPATCH_BATCH_SIZE);
        Map<UUID, CycleAutomationRunService.CycleAutomationConfig> cfgCache = new HashMap<>();
        for (int iteration = 0; iteration < 500; iteration++) {
            if (AutomationExecutionQueueService.countProjectInFlightExecutionJobs(projectId) >= maxProject) {
                return;
            }
            List<Map<String, Object>> candidates =
                    AutomationExecutionQueueService.listJobsPendingBullDispatch(projectId, 500);
            if (candidates.isEmpty()) {
                return;
            }
            List<Map<String, Object>> batch = new ArrayList<>();
            boolean dispatchedThisPass = false;
            for (Map<String, Object> row : candidates) {
                if (AutomationExecutionQueueService.countProjectInFlightExecutionJobs(projectId) >= maxProject) {
                    break;
                }
                UUID runId = UUID.fromString(String.valueOf(row.get("runId")));
                int maxRun = AutomationExecutionQueueService.getRunMaxParallel(runId);
                if (AutomationExecutionQueueService.countRunInFlightExecutionJobs(runId) >= maxRun) {
                    continue;
                }
                UUID cycleId = UUID.fromString(String.valueOf(row.get("cycleId")));
                CycleAutomationRunService.CycleAutomationConfig cfg =
                        cfgCache.computeIfAbsent(cycleId, CycleAutomationRunService::resolveCycleAutomationConfig);
                batch.add(buildPayload(row, cfg));
                if (batch.size() >= batchSize) {
                    flushBatch(batch);
                    batch.clear();
                    dispatchedThisPass = true;
                }
            }
            if (!batch.isEmpty()) {
                flushBatch(batch);
                dispatchedThisPass = true;
            }
            if (!dispatchedThisPass) {
                return;
            }
        }
    }

    /**
     * Re-fill Redis after DB-only jobs appear (e.g. stale recovery). Best-effort across all projects.
     */
    public static void dispatchAllProjectsWithPendingJobs() {
        for (UUID projectId : AutomationExecutionQueueService.listProjectIdsWithPendingBullDispatch()) {
            dispatchAvailableSlots(projectId);
        }
    }

    private static Map<String, Object> buildPayload(
            Map<String, Object> row,
            CycleAutomationRunService.CycleAutomationConfig automationConfig
    ) {
        UUID cycleId = UUID.fromString(String.valueOf(row.get("cycleId")));
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("jobId", String.valueOf(row.get("jobId")));
        payload.put("projectId", String.valueOf(CycleService.getProjectIdForCycle(cycleId)));
        payload.put("runId", String.valueOf(row.get("runId")));
        payload.put("cycleId", String.valueOf(row.get("cycleId")));
        payload.put("executionId", String.valueOf(row.get("executionId")));
        payload.put("script", String.valueOf(row.get("script")));
        payload.put("startUrl", row.get("startUrl"));
        payload.put("maxRetries", row.get("maxRetries"));
        payload.put("executionProvider", row.get("executionProvider"));
        payload.put("providerPayload", row.get("providerPayload"));
        payload.put("shardIndex", row.get("shardIndex"));
        payload.put("shardTotal", row.get("shardTotal"));
        payload.put("modelProvider", automationConfig.modelProvider());
        payload.put("modelApiKey", automationConfig.modelApiKey());
        payload.put("model", automationConfig.model());
        payload.put("cacheScope", String.valueOf(cycleId) + "/" + String.valueOf(row.get("executionId")));
        return payload;
    }

    private static void flushBatch(List<Map<String, Object>> payloads) {
        if (payloads.isEmpty()) {
            return;
        }
        try {
            List<Map<String, Object>> results = AutomationAgentClient.enqueueAutomationJobsBatch(payloads);
            if (results.size() != payloads.size()) {
                throw new IllegalStateException("Batch enqueue returned " + results.size() + " results for " + payloads.size() + " jobs");
            }
            for (int i = 0; i < payloads.size(); i++) {
                Map<String, Object> payload = payloads.get(i);
                UUID jobId = UUID.fromString(String.valueOf(payload.get("jobId")));
                Object qid = results.get(i).get("queueJobId");
                String queueJobId = qid != null ? String.valueOf(qid) : String.valueOf(jobId);
                AutomationExecutionQueueService.markJobEnqueued(jobId, queueJobId);
            }
        } catch (Exception e) {
            for (Map<String, Object> payload : payloads) {
                UUID jobId = UUID.fromString(String.valueOf(payload.get("jobId")));
                try {
                    Map<String, Object> queued = AutomationAgentClient.enqueueAutomationJob(payload);
                    String queueJobId = queued.get("queueJobId") instanceof String s ? s : String.valueOf(jobId);
                    AutomationExecutionQueueService.markJobEnqueued(jobId, queueJobId);
                } catch (Exception inner) {
                    AutomationExecutionQueueService.markJobFailed(
                            jobId, "Queue enqueue failed: " + inner.getMessage(), false, 0);
                }
            }
        }
    }

    private AutomationExecutionDispatchService() {}
}
