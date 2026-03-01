package com.bettercases.cycle;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

public final class CycleAutomationRunTracker {
    private static final ConcurrentHashMap<UUID, RunState> RUNS = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<UUID, UUID> ACTIVE_RUNS_BY_CYCLE = new ConcurrentHashMap<>();

    public static UUID start(UUID cycleId, List<CycleAutomationRunService.ExecutionScriptRow> rows) {
        UUID existing = ACTIVE_RUNS_BY_CYCLE.get(cycleId);
        if (existing != null) {
            RunState current = RUNS.get(existing);
            if (current != null && "running".equals(current.status)) {
                throw new io.javalin.http.BadRequestResponse("An automated run is already in progress for this test run.");
            }
        }
        UUID runId = UUID.randomUUID();
        RunState state = new RunState();
        state.runId = runId;
        state.cycleId = cycleId;
        state.status = "running";
        state.startedAt = Instant.now().toString();
        state.totalCases = rows.size();
        int index = 0;
        for (CycleAutomationRunService.ExecutionScriptRow row : rows) {
            index++;
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("executionId", row.executionId().toString());
            item.put("title", row.title());
            item.put("externalId", row.externalId());
            item.put("status", "queued");
            item.put("index", index);
            state.items.add(item);
            state.indexByExecutionId.put(row.executionId(), index - 1);
        }
        RUNS.put(runId, state);
        ACTIVE_RUNS_BY_CYCLE.put(cycleId, runId);
        return runId;
    }

    public static void markCurrent(UUID runId, UUID executionId, String status, String message) {
        RunState state = requireRun(runId);
        Integer idx = state.indexByExecutionId.get(executionId);
        if (idx == null) return;
        state.currentExecutionId = executionId.toString();
        Map<String, Object> item = state.items.get(idx);
        item.put("status", status);
        if (message != null) item.put("message", message);
    }

    public static void markResult(UUID runId, UUID executionId, String status, String message) {
        RunState state = requireRun(runId);
        Integer idx = state.indexByExecutionId.get(executionId);
        if (idx == null) return;
        Map<String, Object> item = state.items.get(idx);
        item.put("status", status);
        if (message != null) item.put("message", message);
        state.currentExecutionId = executionId.toString();
        if ("passed".equalsIgnoreCase(status)) state.passed++;
        if ("failed".equalsIgnoreCase(status)) state.failed++;
        state.completed = Math.max(0, state.passed + state.failed);
    }

    public static void complete(UUID runId) {
        RunState state = requireRun(runId);
        state.status = "completed";
        state.endedAt = Instant.now().toString();
        ACTIVE_RUNS_BY_CYCLE.remove(state.cycleId, runId);
    }

    public static void fail(UUID runId, String error) {
        RunState state = requireRun(runId);
        state.status = "failed";
        state.error = error;
        state.endedAt = Instant.now().toString();
        ACTIVE_RUNS_BY_CYCLE.remove(state.cycleId, runId);
    }

    public static Map<String, Object> snapshot(UUID cycleId, UUID runId) {
        RunState state = RUNS.get(runId);
        if (state == null || !state.cycleId.equals(cycleId)) throw new io.javalin.http.NotFoundResponse();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("runId", state.runId.toString());
        out.put("cycleId", state.cycleId.toString());
        out.put("status", state.status);
        out.put("startedAt", state.startedAt);
        out.put("endedAt", state.endedAt);
        out.put("currentExecutionId", state.currentExecutionId);
        out.put("totalCases", state.totalCases);
        out.put("completed", state.completed);
        out.put("passed", state.passed);
        out.put("failed", state.failed);
        out.put("error", state.error);
        out.put("items", new ArrayList<>(state.items));
        return out;
    }

    private static RunState requireRun(UUID runId) {
        RunState state = RUNS.get(runId);
        if (state == null) throw new io.javalin.http.NotFoundResponse();
        return state;
    }

    private static final class RunState {
        UUID runId;
        UUID cycleId;
        String status;
        String startedAt;
        String endedAt;
        String currentExecutionId;
        int totalCases;
        int completed;
        int passed;
        int failed;
        String error;
        final List<Map<String, Object>> items = new ArrayList<>();
        final Map<UUID, Integer> indexByExecutionId = new LinkedHashMap<>();
    }

    private CycleAutomationRunTracker() {}
}
