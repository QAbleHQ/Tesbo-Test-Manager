package com.bettercases.cycle;

import com.bettercases.Config;

import java.util.LinkedHashMap;
import java.util.Map;

public final class AutomationQueueAutoscalingService {
    public static Map<String, Object> recommendWorkers() {
        Map<String, Object> snapshot = AutomationExecutionQueueService.queueLoadSnapshot();
        int queuedJobs = asInt(snapshot.get("queuedJobs"));
        int runningJobs = asInt(snapshot.get("runningJobs"));
        int activeRuns = asInt(snapshot.get("activeRuns"));
        int targetJobsPerWorker = Math.max(1, Config.AUTOMATION_QUEUE_AUTOSCALE_TARGET_JOBS_PER_WORKER);
        int minWorkers = Math.max(0, Config.AUTOMATION_QUEUE_AUTOSCALE_MIN_WORKERS);
        int maxWorkers = Math.max(minWorkers, Config.AUTOMATION_QUEUE_AUTOSCALE_MAX_WORKERS);
        int warmWorkers = Math.max(0, Config.AUTOMATION_QUEUE_AUTOSCALE_WARM_WORKERS);

        int pressureJobs = queuedJobs + Math.max(0, runningJobs / 2);
        int computed = (int) Math.ceil((double) pressureJobs / (double) targetJobsPerWorker);
        int desired = Math.max(minWorkers, computed);
        if (queuedJobs == 0 && runningJobs == 0) {
            desired = Math.max(minWorkers, warmWorkers);
        }
        desired = Math.min(maxWorkers, desired);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("desiredWorkers", desired);
        out.put("minWorkers", minWorkers);
        out.put("maxWorkers", maxWorkers);
        out.put("targetJobsPerWorker", targetJobsPerWorker);
        out.put("warmWorkers", warmWorkers);
        out.put("queuedJobs", queuedJobs);
        out.put("runningJobs", runningJobs);
        out.put("activeRuns", activeRuns);
        out.put("scaleReason", scaleReason(queuedJobs, runningJobs, desired, minWorkers, maxWorkers));
        return out;
    }

    private static String scaleReason(int queuedJobs, int runningJobs, int desired, int minWorkers, int maxWorkers) {
        if (queuedJobs == 0 && runningJobs == 0) {
            return "Queue is idle; keeping warm/min worker floor.";
        }
        if (desired == maxWorkers) {
            return "Queue pressure reached max worker cap.";
        }
        if (desired == minWorkers && queuedJobs <= 1) {
            return "Low queue pressure; staying near minimum workers.";
        }
        return "Scaling from queue depth and active execution load.";
    }

    private static int asInt(Object value) {
        if (value instanceof Number n) {
            return n.intValue();
        }
        if (value instanceof String s) {
            try {
                return Integer.parseInt(s);
            } catch (NumberFormatException ignored) {
                return 0;
            }
        }
        return 0;
    }

    private AutomationQueueAutoscalingService() {}
}
