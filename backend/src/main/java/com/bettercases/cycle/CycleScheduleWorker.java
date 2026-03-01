package com.bettercases.cycle;

import com.bettercases.Config;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public final class CycleScheduleWorker {
    private static final ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "cycle-schedule-worker");
        t.setDaemon(true);
        return t;
    });

    public static void start() {
        executor.scheduleWithFixedDelay(CycleScheduleWorker::pollAndRun, 10, 30, TimeUnit.SECONDS);
    }

    private static void pollAndRun() {
        if ("queue".equals(Config.AUTOMATION_EXECUTION_MODE)) {
            AutomationExecutionQueueService.recoverStuckRunningJobs(Config.AUTOMATION_QUEUE_STALE_MINUTES);
        }
        List<Map<String, Object>> due = CycleRunScheduleService.claimDueSchedules(10);
        for (Map<String, Object> schedule : due) {
            UUID scheduleId = UUID.fromString(String.valueOf(schedule.get("id")));
            UUID cycleId = UUID.fromString(String.valueOf(schedule.get("cycleId")));
            try {
                if ("queue".equals(Config.AUTOMATION_EXECUTION_MODE)) {
                    // Queue mode is async; mark schedule tick as successfully dispatched.
                    CycleAutomationRunService.executeAutomatedAsyncInternal(cycleId, true);
                    CycleRunScheduleService.finishRun(scheduleId, "queued", null);
                } else {
                    CycleAutomationRunService.executeAutomatedInternal(cycleId, true);
                    CycleRunScheduleService.finishRun(scheduleId, "passed", null);
                }
            } catch (Exception e) {
                CycleRunScheduleService.finishRun(scheduleId, "failed", e.getMessage());
            }
        }
    }

    private CycleScheduleWorker() {}
}
