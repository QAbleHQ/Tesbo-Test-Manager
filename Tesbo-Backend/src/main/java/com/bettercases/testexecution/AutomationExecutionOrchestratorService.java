package com.bettercases.testexecution;

import com.bettercases.Config;

import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class AutomationExecutionOrchestratorService {
    public static Map<String, Object> enqueueRun(
            UUID projectId,
            UUID cycleId,
            List<CycleAutomationRunService.ExecutionScriptRow> rows,
            CycleAutomationRunService.CycleAutomationConfig automationConfig,
            int maxRetries
    ) {
        UUID activeRun = AutomationExecutionQueueService.findActiveRunId(cycleId);
        if (activeRun != null) {
            throw new io.javalin.http.ConflictResponse("An automated run is already in progress for this test run.");
        }
        int activeProjectRuns = AutomationExecutionQueueService.countActiveRunsForProject(projectId);
        if (activeProjectRuns >= Math.max(1, Config.AUTOMATION_QUEUE_MAX_ACTIVE_RUNS_PER_PROJECT)) {
            throw new io.javalin.http.BadRequestResponse(
                    "Project queue is at active run capacity. Please wait for current runs to finish."
            );
        }
        int queuedProjectJobs = AutomationExecutionQueueService.countQueuedJobsForProject(projectId);
        int incomingQueueable = (int) rows.stream().filter(r -> r.script() != null && !r.script().isBlank()).count();
        int maxQueuedPerProject = Math.max(1, Config.AUTOMATION_QUEUE_MAX_QUEUED_JOBS_PER_PROJECT);
        if (queuedProjectJobs + incomingQueueable > maxQueuedPerProject) {
            throw new io.javalin.http.BadRequestResponse(
                    "Project queue is at capacity. Reduce batch size or wait for queued jobs to drain."
            );
        }
        Map<UUID, Long> estimatedDurations = AutomationExecutionQueueService.estimateExecutionDurationsMillisForRows(rows);
        UUID runId = AutomationExecutionQueueService.createRunWithJobs(
                cycleId,
                rows,
                maxRetries,
                automationConfig.startUrl(),
                automationConfig.executionProvider(),
                automationConfig.maxParallel(),
                automationConfig.providerConfig(),
                estimatedDurations
        );
        AutomationExecutionDispatchService.dispatchAvailableSlots(projectId);
        return Map.of(
                "runId", runId.toString(),
                "cycleId", cycleId.toString(),
                "status", "running",
                "totalCases", rows.size(),
                "executionProvider", automationConfig.executionProvider(),
                "maxParallel", automationConfig.maxParallel(),
                "estimatedScheduling", "duration-aware"
        );
    }

    private AutomationExecutionOrchestratorService() {}
}
