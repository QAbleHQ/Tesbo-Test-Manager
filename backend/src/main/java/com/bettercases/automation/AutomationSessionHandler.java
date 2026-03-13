package com.bettercases.automation;

import com.bettercases.Database;
import com.bettercases.Config;
import com.bettercases.ai.AiHandler;
import com.bettercases.audit.AuditService;
import com.bettercases.auth.SessionFilter;
import com.bettercases.project.ProjectService;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.javalin.http.Context;

import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public final class AutomationSessionHandler {
    private static final HttpClient streamClient = HttpClient.newBuilder().build();
    private static final ObjectMapper mapper = new ObjectMapper();
    private static final ExecutorService commandWorkerPool = Executors.newCachedThreadPool();
    private static final ConcurrentHashMap<UUID, SessionCommandState> commandStates = new ConcurrentHashMap<>();

    private static final class CommandEnvelope {
        private final UUID sessionId;
        private final UUID projectId;
        private final UUID testcaseId;
        private final UUID userId;
        private final UUID commandId;
        private final String rawCommand;
        private final String objective;
        private final boolean autonomousMode;

        private CommandEnvelope(UUID sessionId, UUID projectId, UUID testcaseId, UUID userId, UUID commandId,
                                String rawCommand, String objective, boolean autonomousMode) {
            this.sessionId = sessionId;
            this.projectId = projectId;
            this.testcaseId = testcaseId;
            this.userId = userId;
            this.commandId = commandId;
            this.rawCommand = rawCommand;
            this.objective = objective;
            this.autonomousMode = autonomousMode;
        }
    }

    private static final class SessionCommandState {
        private final ConcurrentLinkedQueue<CommandEnvelope> queue = new ConcurrentLinkedQueue<>();
        private final AtomicBoolean workerRunning = new AtomicBoolean(false);
        private volatile UUID activeCommandId = null;
        private volatile AtomicBoolean activeCancelSignal = null;
    }
    public static void start(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID testcaseId = UUID.fromString(ctx.pathParam("testcaseId"));
        AutomationContracts.StartSessionBody body = ctx.bodyAsClass(AutomationContracts.StartSessionBody.class);
        String startUrl = body != null ? body.startUrl : null;

        Map<String, Object> session = AutomationSessionService.startSession(projectId, testcaseId, userId, startUrl);
        UUID sessionId = UUID.fromString(String.valueOf(session.get("id")));
        try {
            BrowserbaseCredentialsService.Credentials browserbase = BrowserbaseCredentialsService.resolve(projectId);
            Map<String, String> aiConfig = AiHandler.readAiConfig(projectId);
            String provider = String.valueOf(aiConfig.getOrDefault("provider", "openai")).trim().toLowerCase();
            if (!"anthropic".equals(provider)) provider = "openai";
            String modelApiKey = "anthropic".equals(provider)
                    ? String.valueOf(aiConfig.getOrDefault("anthropicApiKey", "")).trim()
                    : String.valueOf(aiConfig.getOrDefault("openAiApiKey", "")).trim();
            String model = String.valueOf(aiConfig.getOrDefault("model", "")).trim();

            Map<String, Object> agentSession = AutomationAgentClient.createSession(
                    sessionId,
                    startUrl,
                    projectId,
                    testcaseId,
                    browserbase.apiKey(),
                    browserbase.projectId(),
                    provider,
                    modelApiKey,
                    model
            );
            String sessionType = String.valueOf(agentSession.getOrDefault("sessionType", "playwright"));
            Map<String, Object> browserMeta = new HashMap<>();
            browserMeta.put("sessionType", sessionType);
            if (browserbase.projectId() != null && !browserbase.projectId().isBlank()) {
                browserMeta.put("browserbaseProjectId", browserbase.projectId());
            }
            AutomationSessionService.touchState(sessionId, startUrl == null ? "" : startUrl, null, browserMeta);
        } catch (Exception e) {
            AutomationSessionService.markSessionStartFailed(sessionId, "Session start failed: " + e.getMessage());
            throw new io.javalin.http.ServiceUnavailableResponse("Failed to create automation session: " + e.getMessage());
        }
        try {
            AuditService.logActivity(userId, projectId, "automation_session_started", "testcase", testcaseId.toString(), null);
        } catch (Exception ignored) {}
        ctx.status(201).json(session);
    }

    public static void runCommand(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID sessionId = UUID.fromString(ctx.pathParam("sessionId"));
        Map<String, Object> session = AutomationSessionService.getSession(sessionId, projectId, userId)
                .orElseThrow(io.javalin.http.NotFoundResponse::new);
        UUID testcaseId = UUID.fromString(String.valueOf(session.get("testcaseId")));
        AutomationContracts.CommandBody body = ctx.bodyAsClass(AutomationContracts.CommandBody.class);
        String command = body == null ? null : body.command;
        String rawCommand = command == null ? "" : command.trim();
        if (rawCommand.isBlank()) {
            ctx.status(400).json(Map.of("error", "command is required"));
            return;
        }
        boolean autonomousMode = rawCommand.toLowerCase().startsWith("autonomous mode objective:");
        String objective = autonomousMode
                ? rawCommand.substring("Autonomous mode objective:".length()).trim()
                : rawCommand;
        if (objective.isBlank()) {
            ctx.status(400).json(Map.of("error", "command is required"));
            return;
        }

        UUID commandId = UUID.randomUUID();
        SessionCommandState state = commandStates.computeIfAbsent(sessionId, ignored -> new SessionCommandState());
        CommandEnvelope envelope = new CommandEnvelope(
                sessionId,
                projectId,
                testcaseId,
                userId,
                commandId,
                rawCommand,
                objective,
                autonomousMode
        );
        state.queue.add(envelope);

        Map<String, Object> queuedPayload = new HashMap<>();
        queuedPayload.put("mode", autonomousMode ? "autonomous" : "chat");
        queuedPayload.put("objective", objective);
        queuedPayload.put("queued", true);
        queuedPayload.put("queueDepth", state.queue.size());
        AutomationSessionService.addEvent(
                sessionId, projectId, testcaseId, userId, commandId, "command_queued",
                rawCommand,
                queuedPayload,
                null,
                null
        );

        triggerQueueWorker(sessionId);

        ctx.status(202).json(Map.of(
                "commandId", commandId.toString(),
                "requiresClarification", false,
                "queued", true,
                "queueDepth", state.queue.size()
        ));
    }

    private static void triggerQueueWorker(UUID sessionId) {
        SessionCommandState state = commandStates.computeIfAbsent(sessionId, ignored -> new SessionCommandState());
        if (!state.workerRunning.compareAndSet(false, true)) return;
        commandWorkerPool.submit(() -> {
            try {
                while (true) {
                    CommandEnvelope envelope = state.queue.poll();
                    if (envelope == null) break;
                    AtomicBoolean cancelSignal = new AtomicBoolean(false);
                    state.activeCommandId = envelope.commandId;
                    state.activeCancelSignal = cancelSignal;
                    try {
                        executeQueuedCommand(envelope, cancelSignal);
                    } catch (Exception error) {
                        AutomationSessionService.addEvent(
                                envelope.sessionId,
                                envelope.projectId,
                                envelope.testcaseId,
                                envelope.userId,
                                envelope.commandId,
                                "command_failed",
                                envelope.rawCommand,
                                Map.of("mode", envelope.autonomousMode ? "autonomous" : "chat"),
                                Map.of("error", error.getMessage() == null ? "Command failed." : error.getMessage()),
                                null
                        );
                    } finally {
                        state.activeCommandId = null;
                        state.activeCancelSignal = null;
                    }
                }
            } finally {
                state.workerRunning.set(false);
                if (!state.queue.isEmpty()) {
                    triggerQueueWorker(sessionId);
                }
            }
        });
    }

    private static void executeQueuedCommand(CommandEnvelope envelope, AtomicBoolean cancelSignal) {
        String currentUrl = "";
        String pageText = "";
        String domPlanningContext = "";
        String sessionType = "playwright";
        try {
            Map<String, Object> persistedSession = AutomationSessionService.getSession(envelope.sessionId, envelope.projectId, envelope.userId)
                    .orElseThrow(io.javalin.http.NotFoundResponse::new);
            currentUrl = (String) persistedSession.get("currentUrl");
            Object rawMeta = persistedSession.get("browserContextMeta");
            if (rawMeta instanceof String metaJson && !metaJson.isBlank()) {
                try {
                    Map<String, Object> meta = mapper.readValue(metaJson, new TypeReference<>() {});
                    Object type = meta.get("sessionType");
                    if (type instanceof String s && !s.isBlank()) {
                        sessionType = s.trim().toLowerCase();
                    }
                } catch (Exception ignored) {}
            }
        } catch (Exception ignored) {}
        try {
            Map<String, Object> liveState = AutomationAgentClient.getSessionState(envelope.sessionId);
            Object liveUrl = liveState.get("currentUrl");
            if (liveUrl instanceof String s && !s.isBlank()) {
                currentUrl = s;
            }
            Object liveText = liveState.get("pageText");
            if (liveText instanceof String s) {
                pageText = s;
            }
            domPlanningContext = buildDomPlanningContext(liveState);
        } catch (Exception ignored) {}

        if ("stagehand".equals(sessionType)) {
            executeStagehandCommand(envelope, cancelSignal, currentUrl);
            return;
        }

        if (!envelope.autonomousMode) {
            executeChatCommand(envelope, cancelSignal, currentUrl, pageText, domPlanningContext);
            return;
        }
        executeAutonomousCommand(envelope, cancelSignal, currentUrl, pageText, domPlanningContext);
    }

    private static void executeChatCommand(
            CommandEnvelope envelope,
            AtomicBoolean cancelSignal,
            String currentUrl,
            String pageText,
            String domPlanningContext
    ) {
        if (cancelSignal.get()) {
            appendCancelledEvent(envelope, "Command was stopped before execution started.");
            return;
        }
        AutomationContracts.ActionPlan plan = AutomationIntentParserService.plan(
                envelope.projectId,
                envelope.objective,
                currentUrl,
                pageText,
                domPlanningContext
        );
        AutomationSessionService.addEvent(
                envelope.sessionId, envelope.projectId, envelope.testcaseId, envelope.userId, envelope.commandId,
                plan.requiresClarification ? "clarification_required" : "command_received",
                envelope.rawCommand,
                Map.of(
                        "requiresClarification", plan.requiresClarification,
                        "clarificationQuestion", plan.clarificationQuestion == null ? "" : plan.clarificationQuestion,
                        "steps", plan.steps == null ? List.of() : plan.steps
                ),
                null,
                null
        );
        if (plan.requiresClarification) {
            return;
        }
        if (cancelSignal.get()) {
            appendCancelledEvent(envelope, "Command was stopped before step execution.");
            return;
        }

        AutomationContracts.AgentExecuteResponse executeResponse = AutomationAgentClient.executeSteps(
                envelope.sessionId,
                envelope.commandId.toString(),
                plan.steps
        );
        String screenshotPath = null;
        if (executeResponse.results != null && !executeResponse.results.isEmpty()) {
            screenshotPath = executeResponse.results.get(executeResponse.results.size() - 1).screenshotPath;
        }
        AutomationSessionService.touchState(
                envelope.sessionId,
                executeResponse.currentUrl,
                screenshotPath,
                Map.of("stepCount", executeResponse.results == null ? 0 : executeResponse.results.size())
        );
        Map<String, Object> executionPayload = new HashMap<>();
        executionPayload.put("currentUrl", executeResponse.currentUrl);
        executionPayload.put("results", executeResponse.results);
        executionPayload.put("cancelled", false);
        AutomationSessionService.addEvent(
                envelope.sessionId, envelope.projectId, envelope.testcaseId, envelope.userId, envelope.commandId, "command_executed",
                envelope.rawCommand,
                Map.of("steps", plan.steps),
                executionPayload,
                screenshotPath
        );
    }

    /**
     * Execute command using Stagehand agent.
     * Chat mode should follow the latest user instruction exactly.
     * Autonomous mode can expand into richer end-to-end execution.
     */
    private static void executeStagehandCommand(
            CommandEnvelope envelope,
            AtomicBoolean cancelSignal,
            String currentUrl
    ) {
        if (cancelSignal.get()) {
            appendCancelledEvent(envelope, "Command was stopped before Stagehand execution started.");
            return;
        }

        AutomationSessionService.addEvent(
                envelope.sessionId, envelope.projectId, envelope.testcaseId, envelope.userId, envelope.commandId, "command_received",
                envelope.rawCommand,
                Map.of(
                        "mode", "stagehand",
                        "objective", envelope.objective
                ),
                null,
                null
        );

        String stagehandObjective = envelope.autonomousMode
                ? buildStagehandExecutionObjective(envelope)
                : buildStagehandChatObjective(envelope);
        List<Map<String, Object>> stagehandPlanPreview = extractStagehandPlanPreview(stagehandObjective);
        AutomationSessionService.addEvent(
                envelope.sessionId, envelope.projectId, envelope.testcaseId, envelope.userId, envelope.commandId, "stagehand_plan_sent",
                envelope.rawCommand,
                Map.of(
                        "mode", "stagehand",
                        "objective", envelope.objective,
                        "stagehandObjective", stagehandObjective,
                        "stagehandPlan", stagehandPlanPreview
                ),
                null,
                null
        );
        AutomationSessionService.addEvent(
                envelope.sessionId, envelope.projectId, envelope.testcaseId, envelope.userId, envelope.commandId, "stagehand_execution_started",
                envelope.rawCommand,
                Map.of(
                        "mode", "stagehand",
                        "stage", "running",
                        "plannedStepCount", stagehandPlanPreview.size()
                ),
                null,
                null
        );
        AutomationContracts.AgentExecuteResponse executeResponse = AutomationAgentClient.executeStagehand(
                envelope.sessionId,
                envelope.commandId.toString(),
                stagehandObjective
        );
        String screenshotPath = null;
        if (executeResponse.results != null && !executeResponse.results.isEmpty()) {
            screenshotPath = executeResponse.results.get(executeResponse.results.size() - 1).screenshotPath;
        }
        Map<String, Object> browserMeta = new HashMap<>();
        browserMeta.put("sessionType", "stagehand");
        browserMeta.put("stepCount", executeResponse.results == null ? 0 : executeResponse.results.size());
        AutomationSessionService.touchState(
                envelope.sessionId,
                executeResponse.currentUrl == null || executeResponse.currentUrl.isBlank() ? currentUrl : executeResponse.currentUrl,
                screenshotPath,
                browserMeta
        );
        Map<String, Object> executionPayload = new HashMap<>();
        executionPayload.put("mode", "stagehand");
        executionPayload.put("currentUrl", executeResponse.currentUrl);
        executionPayload.put("results", executeResponse.results);
        executionPayload.put("stagehandActions", executeResponse.stagehandActions == null ? List.of() : executeResponse.stagehandActions);
        executionPayload.put("telemetryEvents", executeResponse.telemetryEvents == null ? List.of() : executeResponse.telemetryEvents);
        executionPayload.put("telemetryPlan", executeResponse.telemetryPlan == null ? List.of() : executeResponse.telemetryPlan);
        executionPayload.put("cancelled", false);
        appendStagehandTelemetryEvents(envelope, executeResponse, screenshotPath);
        AutomationSessionService.addEvent(
                envelope.sessionId, envelope.projectId, envelope.testcaseId, envelope.userId, envelope.commandId, "command_executed",
                envelope.rawCommand,
                Map.of(
                        "mode", "stagehand",
                        "objective", envelope.objective,
                        "stagehandObjective", stagehandObjective,
                        "steps", buildStagehandReplaySteps(executeResponse.results)
                ),
                executionPayload,
                screenshotPath
        );
    }

    private static void appendStagehandTelemetryEvents(
            CommandEnvelope envelope,
            AutomationContracts.AgentExecuteResponse executeResponse,
            String defaultScreenshotPath
    ) {
        List<Map<String, Object>> plan = executeResponse.telemetryPlan == null ? List.of() : executeResponse.telemetryPlan;
        if (!plan.isEmpty()) {
            AutomationSessionService.addEvent(
                    envelope.sessionId, envelope.projectId, envelope.testcaseId, envelope.userId, envelope.commandId, "stagehand_plan_compiled",
                    envelope.rawCommand,
                    Map.of(
                            "mode", "stagehand",
                            "stagehandPlan", plan,
                            "plannedStepCount", plan.size()
                    ),
                    null,
                    null
            );
        }

        List<Map<String, Object>> telemetryEvents = executeResponse.telemetryEvents == null ? List.of() : executeResponse.telemetryEvents;
        for (Map<String, Object> telemetry : telemetryEvents) {
            if (telemetry == null || telemetry.isEmpty()) continue;
            String eventType = String.valueOf(telemetry.getOrDefault("eventType", "")).trim().toLowerCase();
            String mappedType = switch (eventType) {
                case "observe" -> "stagehand_step_observed";
                case "act" -> "stagehand_step_acted";
                case "extract" -> "stagehand_step_extracted";
                default -> "stagehand_step_event";
            };
            Map<String, Object> parsedAction = new HashMap<>();
            parsedAction.put("mode", "stagehand");
            parsedAction.put("stage", eventType.isBlank() ? "unknown" : eventType);
            parsedAction.put("stepId", String.valueOf(telemetry.getOrDefault("stepId", "")));
            parsedAction.put("instruction", String.valueOf(telemetry.getOrDefault("instruction", "")));
            parsedAction.put("success", telemetry.get("success"));
            parsedAction.put("chosenReason", telemetry.get("chosenReason"));
            parsedAction.put("chosenIndex", telemetry.get("chosenIndex"));
            parsedAction.put("retryCount", telemetry.get("retryCount"));
            parsedAction.put("cacheStatus", telemetry.get("cacheStatus"));
            parsedAction.put("message", telemetry.get("message"));
            parsedAction.put("actionDescription", telemetry.get("actionDescription"));
            parsedAction.put("elapsedMs", telemetry.get("elapsedMs"));
            parsedAction.put("actAttempts", telemetry.get("actAttempts"));
            parsedAction.put("actions", telemetry.get("actions"));
            parsedAction.put("candidates", telemetry.get("candidates"));
            parsedAction.put("result", telemetry.get("result"));
            String screenshotPath = asSafeText(telemetry.get("screenshotAfter"));
            if (screenshotPath.isBlank()) screenshotPath = asSafeText(telemetry.get("screenshotBefore"));
            if (screenshotPath.isBlank()) screenshotPath = defaultScreenshotPath == null ? "" : defaultScreenshotPath;
            AutomationSessionService.addEvent(
                    envelope.sessionId, envelope.projectId, envelope.testcaseId, envelope.userId, envelope.commandId, mappedType,
                    envelope.rawCommand,
                    parsedAction,
                    telemetry,
                    screenshotPath.isBlank() ? null : screenshotPath
            );
        }
    }

    private static String buildStagehandExecutionObjective(CommandEnvelope envelope) {
        String goal = envelope.objective == null ? "" : envelope.objective.trim();
        if (goal.isBlank()) {
            goal = envelope.rawCommand == null ? "" : envelope.rawCommand.trim();
        }

        Map<String, Object> testcase = loadTestcaseContext(envelope.projectId, envelope.testcaseId);
        String title = String.valueOf(testcase.getOrDefault("title", "")).trim();
        String description = String.valueOf(testcase.getOrDefault("description", "")).trim();
        String preconditions = String.valueOf(testcase.getOrDefault("preconditions", "")).trim();
        String postconditions = String.valueOf(testcase.getOrDefault("postconditions", "")).trim();
        String steps = String.valueOf(testcase.getOrDefault("steps", "")).trim();
        String testData = String.valueOf(testcase.getOrDefault("testData", "")).trim();

        List<Map<String, Object>> events = AutomationSessionService.listEvents(envelope.sessionId, 200);
        List<String> feedbackSignals = extractRecentFeedbackSignals(events, envelope.rawCommand);

        StringBuilder objective = new StringBuilder();
        objective.append("Primary Goal:\n").append(goal).append("\n\n");
        if (!title.isBlank()) objective.append("Test Case Title:\n").append(title).append("\n\n");
        if (!description.isBlank()) objective.append("Description:\n").append(limitBlock(description, 1200)).append("\n\n");
        if (!preconditions.isBlank()) objective.append("Preconditions:\n").append(limitBlock(preconditions, 1000)).append("\n\n");
        if (!steps.isBlank()) objective.append("Expected Steps:\n").append(limitBlock(steps, 3000)).append("\n\n");
        if (!testData.isBlank()) {
            objective.append("Test Data (use exact values):\n").append(limitBlock(testData, 1500)).append("\n\n");
            String credentialsBlock = formatLoginCredentials(testData);
            if (!credentialsBlock.isBlank()) {
                objective.append("CRITICAL - Login credentials (use EXACTLY; never use user@example.com or password123):\n")
                        .append(credentialsBlock).append("\n\n");
            }
        }
        if (!postconditions.isBlank()) objective.append("Expected Outcome:\n").append(limitBlock(postconditions, 1200)).append("\n\n");
        if (!feedbackSignals.isEmpty()) {
            objective.append("User Feedback / Preferences (latest first):\n");
            for (String feedback : feedbackSignals) {
                objective.append("- ").append(limitBlock(feedback, 300)).append("\n");
            }
            objective.append("\n");
        }

        objective.append("Execution Requirements:\n")
                .append("1) Perform MULTI-STEP browser actions to satisfy the full test goal, not a single action.\n")
                .append("2) Complete login FIRST with the exact credentials from Test Data above. Only after login succeeds, proceed to post-login steps (e.g. program tabs, create program).\n")
                .append("3) Use provided test data values exactly where applicable. For login forms: fill Email and Password with the exact values from Test Data / Login credentials. Never use placeholder values.\n")
                .append("4) Validate outcomes with assertions: prefer Stagehand extraction/assertion checks.\n")
                .append("5) If a strict Stagehand assertion is not reliable for a specific check, still verify via deterministic page evidence before finishing.\n")
                .append("6) Avoid unnecessary exploration once required goals are satisfied.\n");
        return objective.toString().trim();
    }

    private static String buildStagehandChatObjective(CommandEnvelope envelope) {
        String instruction = envelope.objective == null ? "" : envelope.objective.trim();
        if (instruction.isBlank()) {
            instruction = envelope.rawCommand == null ? "" : envelope.rawCommand.trim();
        }
        if (instruction.isBlank()) {
            return "Follow the latest user instruction exactly.";
        }
        return ("User instruction:\n" + instruction + "\n\n"
                + "Execution rules:\n"
                + "1) Follow the latest user instruction exactly as written.\n"
                + "2) Do only what is required for this instruction; do not expand scope.\n"
                + "3) If the instruction is single-step (for example: click a button), perform that single step and stop.\n"
                + "4) Do not enter text, credentials, or perform extra navigation unless explicitly requested.\n"
                + "5) If the target is ambiguous, choose the closest visible match by label/text and execute once.");
    }

    private static List<Map<String, Object>> extractStagehandPlanPreview(String objective) {
        if (objective == null || objective.isBlank()) return List.of();
        String[] lines = objective.replace("\r", "").split("\n");
        java.util.ArrayList<Map<String, Object>> out = new java.util.ArrayList<>();
        boolean inStepSection = false;
        for (String lineRaw : lines) {
            String line = lineRaw == null ? "" : lineRaw.trim();
            if (line.isBlank()) continue;
            String lower = line.toLowerCase();
            if (lower.startsWith("expected steps:") || lower.startsWith("### steps to execute")) {
                inStepSection = true;
                continue;
            }
            if (inStepSection && (lower.startsWith("test data") || lower.startsWith("execution requirements") || lower.startsWith("expected outcome"))) {
                break;
            }
            if (!inStepSection) continue;
            String normalized = line.replaceFirst("^\\d+\\.\\s*", "").trim();
            if (normalized.isBlank()) continue;
            Map<String, Object> step = new HashMap<>();
            step.put("id", "preview-" + (out.size() + 1));
            step.put("instruction", normalized);
            out.add(step);
        }
        return out;
    }

    private static List<String> extractRecentFeedbackSignals(List<Map<String, Object>> events, String currentRawCommand) {
        if (events == null || events.isEmpty()) return List.of();
        java.util.ArrayList<String> out = new java.util.ArrayList<>();
        String current = currentRawCommand == null ? "" : currentRawCommand.trim();
        for (int i = events.size() - 1; i >= 0 && out.size() < 5; i--) {
            Map<String, Object> event = events.get(i);
            if (event == null) continue;
            String eventType = String.valueOf(event.getOrDefault("eventType", "")).trim();
            if (!"command_received".equalsIgnoreCase(eventType)) continue;
            String rawCommand = String.valueOf(event.getOrDefault("rawCommand", "")).trim();
            if (rawCommand.isBlank()) continue;
            if (rawCommand.equals(current)) continue;
            String lower = rawCommand.toLowerCase();
            if (lower.startsWith("autonomous mode objective:")) continue;
            if (lower.startsWith("run script")) continue;
            out.add(rawCommand);
        }
        return out;
    }

    private static String limitBlock(String value, int maxChars) {
        if (value == null) return "";
        String normalized = value.replace("\r", "").trim();
        if (normalized.length() <= maxChars) return normalized;
        return normalized.substring(0, Math.max(0, maxChars)) + "...";
    }

    /** Parse login credentials from test data (e.g. "Credentials : email/password" or "email / password"). */
    private static String formatLoginCredentials(String testData) {
        if (testData == null || testData.isBlank()) return "";
        String s = testData.replace("\r", "").trim();
        // Match patterns like "Credentials : email@domain.com/ password" or "email@domain.com / password"
        java.util.regex.Matcher m = java.util.regex.Pattern.compile(
                "(?i)(?:credentials?\\s*[:=]?\\s*)?([^\\s/]+@[^\\s/]+)\\s*/\\s*([^\\s]+)"
        ).matcher(s);
        if (m.find()) {
            String email = m.group(1).trim();
            String password = m.group(2).trim();
            if (!email.isBlank() && !password.isBlank()) {
                return "Email: " + email + ", Password: " + password;
            }
        }
        return "";
    }

    private static Map<String, Object> loadTestcaseContext(UUID projectId, UUID testcaseId) {
        String sql = """
                SELECT title, description, preconditions, postconditions, steps, test_data
                FROM testcases
                WHERE id = ? AND project_id = ?
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, testcaseId);
            ps.setObject(2, projectId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) return Map.of();
            Map<String, Object> out = new HashMap<>();
            out.put("title", rs.getString("title"));
            out.put("description", rs.getString("description"));
            out.put("preconditions", rs.getString("preconditions"));
            out.put("postconditions", rs.getString("postconditions"));
            out.put("steps", rs.getString("steps"));
            out.put("testData", rs.getString("test_data"));
            return out;
        } catch (Exception ignored) {
            return Map.of();
        }
    }

    private static List<Map<String, Object>> buildStagehandReplaySteps(List<AutomationContracts.StepResult> results) {
        if (results == null || results.isEmpty()) return List.of();
        List<Map<String, Object>> out = new java.util.ArrayList<>();
        for (AutomationContracts.StepResult result : results) {
            if (result == null) continue;
            if (!"passed".equalsIgnoreCase(String.valueOf(result.status))) continue;
            Map<String, Object> step = new HashMap<>();
            step.put("id", result.stepId == null ? "" : result.stepId);
            step.put("action", result.action == null || result.action.isBlank() ? "act" : result.action);
            String selectorUsed = result.selectorUsed == null ? "" : result.selectorUsed.trim();
            if (selectorUsed.startsWith("xpath:")) {
                step.put("selector", "xpath=" + selectorUsed.substring("xpath:".length()).trim());
            } else if (selectorUsed.startsWith("selector:")) {
                step.put("selector", selectorUsed.substring("selector:".length()).trim());
            } else if (!selectorUsed.isBlank()) {
                step.put("targetDescription", selectorUsed);
            }
            if (result.message != null && !result.message.isBlank()) {
                step.put("targetDescription", result.message);
            }
            out.add(step);
        }
        return out;
    }

    private static void executeAutonomousCommand(
            CommandEnvelope envelope,
            AtomicBoolean cancelSignal,
            String currentUrl,
            String pageText,
            String domPlanningContext
    ) {
        final int MAX_AUTONOMOUS_TURNS = Math.max(1, Config.AUTOMATION_AUTONOMOUS_MAX_TURNS);
        final int MAX_AUTONOMOUS_STEPS = Math.max(1, Config.AUTOMATION_AUTONOMOUS_MAX_STEPS);
        int executedSteps = 0;
        int turnCount = 0;
        int noActionTurns = 0;
        boolean goalAchieved = false;
        boolean cancelled = false;
        String completionReason = "";
        String lastScreenshotPath = null;
        String latestUrl = currentUrl;
        List<String> history = new java.util.ArrayList<>();
        List<AutomationContracts.StepResult> allResults = new java.util.ArrayList<>();
        List<Map<String, Object>> plannedTurns = new java.util.ArrayList<>();

        AutomationSessionService.addEvent(
                envelope.sessionId, envelope.projectId, envelope.testcaseId, envelope.userId, envelope.commandId, "command_received",
                envelope.rawCommand,
                Map.of("mode", "autonomous", "objective", envelope.objective),
                null,
                null
        );

        for (int turn = 1; turn <= MAX_AUTONOMOUS_TURNS; turn++) {
            if (cancelSignal.get()) {
                cancelled = true;
                completionReason = "Autonomous run stopped by user.";
                break;
            }
            turnCount = turn;
            if (executedSteps >= MAX_AUTONOMOUS_STEPS) {
                completionReason = "Autonomous run stopped after reaching step budget.";
                break;
            }

            String loopUrl = latestUrl;
            String loopText = pageText;
            String loopDomContext = domPlanningContext;
            try {
                Map<String, Object> liveState = AutomationAgentClient.getSessionState(envelope.sessionId);
                Object liveUrl = liveState.get("currentUrl");
                if (liveUrl instanceof String s && !s.isBlank()) loopUrl = s;
                Object liveText = liveState.get("pageText");
                if (liveText instanceof String s) loopText = s;
                loopDomContext = buildDomPlanningContext(liveState);
            } catch (Exception ignored) {}

            int remaining = Math.max(0, MAX_AUTONOMOUS_STEPS - executedSteps);
            AutomationContracts.ActionPlan turnPlan = AutomationIntentParserService.planAutonomousTurn(
                    envelope.projectId,
                    envelope.objective,
                    loopUrl,
                    loopText,
                    loopDomContext,
                    history,
                    remaining
            );

            if (turnPlan.requiresClarification) {
                AutomationSessionService.addEvent(
                        envelope.sessionId, envelope.projectId, envelope.testcaseId, envelope.userId, envelope.commandId, "clarification_required",
                        envelope.rawCommand,
                        Map.of(
                                "mode", "autonomous",
                                "turn", turn,
                                "clarificationQuestion", turnPlan.clarificationQuestion == null ? "" : turnPlan.clarificationQuestion
                        ),
                        null,
                        null
                );
                return;
            }

            if (turnPlan.goalAchieved && (turnPlan.steps == null || turnPlan.steps.isEmpty())) {
                goalAchieved = true;
                completionReason = turnPlan.completionReason == null ? "Objective reached." : turnPlan.completionReason;
                break;
            }

            List<AutomationContracts.ActionStep> candidateSteps = turnPlan.steps == null ? List.of() : turnPlan.steps;
            boolean candidateAssertionOnly = !candidateSteps.isEmpty() && candidateSteps.stream().allMatch(step ->
                    step != null &&
                            step.action != null &&
                            (step.action.startsWith("assert_") || "assert_text".equals(step.action))
            );

            if (executedSteps == 0 && (candidateSteps.isEmpty() || candidateAssertionOnly)) {
                history.add("planner returned non-actionable bootstrap turn; requesting action-only bootstrap plan.");
                AutomationContracts.ActionPlan bootstrapPlan = AutomationIntentParserService.planAutonomousBootstrapTurn(
                        envelope.projectId,
                        envelope.objective,
                        loopUrl,
                        loopText,
                        loopDomContext,
                        history,
                        remaining
                );
                List<AutomationContracts.ActionStep> bootstrapSteps =
                        bootstrapPlan.steps == null ? List.of() : bootstrapPlan.steps;
                boolean bootstrapActionable = bootstrapSteps.stream().anyMatch(step ->
                        step != null &&
                                step.action != null &&
                                ("navigate".equals(step.action) || "click".equals(step.action) || "type".equals(step.action))
                );
                if (bootstrapActionable) {
                    turnPlan = bootstrapPlan;
                    candidateSteps = bootstrapSteps;
                    candidateAssertionOnly = false;
                } else {
                    noActionTurns++;
                    if (noActionTurns >= 3) {
                        completionReason = "Autonomous planner returned non-actionable turns repeatedly before any interaction.";
                        break;
                    }
                    continue;
                }
            } else if (candidateSteps.isEmpty()) {
                completionReason = turnPlan.completionReason == null || turnPlan.completionReason.isBlank()
                        ? "Planner returned no actionable steps."
                        : turnPlan.completionReason;
                break;
            }

            boolean assertionOnlyTurn = candidateSteps.stream().allMatch(step ->
                    step != null &&
                            step.action != null &&
                            (step.action.startsWith("assert_") || "assert_text".equals(step.action))
            );
            if (executedSteps == 0 && assertionOnlyTurn) {
                history.add("planner returned assertion-only steps before any action; request actionable interaction steps.");
                noActionTurns++;
                if (noActionTurns >= 3) {
                    completionReason = "Autonomous planner returned non-actionable turns repeatedly before any interaction.";
                    break;
                }
                continue;
            }
            noActionTurns = 0;

            List<AutomationContracts.ActionStep> boundedSteps = candidateSteps;
            if (boundedSteps.size() > remaining) {
                boundedSteps = boundedSteps.subList(0, remaining);
            }
            String turnIntentLabel = inferIntentLabel(envelope.objective, boundedSteps);
            Map<String, Object> turnPlanPayload = new HashMap<>();
            turnPlanPayload.put("mode", "autonomous");
            turnPlanPayload.put("turn", turn);
            turnPlanPayload.put("intentLabel", turnIntentLabel);
            turnPlanPayload.put("remainingBudget", remaining);
            turnPlanPayload.put("steps", boundedSteps);
            AutomationSessionService.addEvent(
                    envelope.sessionId, envelope.projectId, envelope.testcaseId, envelope.userId, envelope.commandId, "autonomous_turn_planned",
                    envelope.rawCommand,
                    turnPlanPayload,
                    null,
                    null
            );

            List<AutomationContracts.StepResult> turnResults = new java.util.ArrayList<>();
            String turnScreenshotPath = null;
            int turnPassed = 0;
            int turnFailed = 0;
            boolean hasFailure = false;
            String turnCurrentUrl = latestUrl;
            String failedAction = "";
            String expectedOutcome = "";
            String observedOutcome = "";

            for (int stepIndex = 0; stepIndex < boundedSteps.size(); stepIndex++) {
                if (cancelSignal.get()) {
                    cancelled = true;
                    completionReason = "Autonomous run stopped by user.";
                    break;
                }
                AutomationContracts.ActionStep step = boundedSteps.get(stepIndex);
                String evaluateText = describeEvaluation(step);
                String actionText = describeAction(step);
                Map<String, Object> evaluatingPayload = new HashMap<>();
                evaluatingPayload.put("mode", "autonomous");
                evaluatingPayload.put("turn", turn);
                evaluatingPayload.put("stepIndex", stepIndex + 1);
                evaluatingPayload.put("stepCount", boundedSteps.size());
                evaluatingPayload.put("intentLabel", turnIntentLabel);
                evaluatingPayload.put("step", step);
                evaluatingPayload.put("evaluateText", evaluateText);
                evaluatingPayload.put("actionText", actionText);
                if (Config.AUTOMATION_AUTONOMOUS_VERBOSE_EVENTS) {
                    AutomationSessionService.addEvent(
                            envelope.sessionId, envelope.projectId, envelope.testcaseId, envelope.userId, envelope.commandId, "autonomous_step_evaluating",
                            envelope.rawCommand,
                            evaluatingPayload,
                            null,
                            null
                    );
                }

                AutomationContracts.AgentExecuteResponse stepResponse = null;
                AutomationContracts.StepResult stepResult;
                try {
                    stepResponse = AutomationAgentClient.executeSteps(
                            envelope.sessionId,
                            envelope.commandId.toString(),
                            List.of(step)
                    );
                    if (stepResponse.results == null || stepResponse.results.isEmpty()) {
                        stepResult = syntheticFailedStepResult(
                                envelope.commandId,
                                step,
                                loopUrl,
                                "No step result was produced by automation agent."
                        );
                    } else {
                        stepResult = stepResponse.results.get(0);
                    }
                } catch (Exception stepError) {
                    String message = stepError.getMessage() == null || stepError.getMessage().isBlank()
                            ? "Automation agent request failed for this step."
                            : stepError.getMessage();
                    stepResult = syntheticFailedStepResult(envelope.commandId, step, loopUrl, message);
                    Map<String, Object> transportPayload = new HashMap<>();
                    transportPayload.put("mode", "autonomous");
                    transportPayload.put("turn", turn);
                    transportPayload.put("stepIndex", stepIndex + 1);
                    transportPayload.put("stepCount", boundedSteps.size());
                    transportPayload.put("intentLabel", turnIntentLabel);
                    transportPayload.put("step", step);
                    transportPayload.put("error", message);
                    AutomationSessionService.addEvent(
                            envelope.sessionId, envelope.projectId, envelope.testcaseId, envelope.userId, envelope.commandId,
                            "autonomous_step_transport_failed",
                            envelope.rawCommand,
                            transportPayload,
                            null,
                            null
                    );
                }
                turnResults.add(stepResult);
                allResults.add(stepResult);
                executedSteps++;
                if ("passed".equalsIgnoreCase(stepResult.status)) turnPassed++;
                else {
                    turnFailed++;
                    hasFailure = true;
                    if (failedAction.isBlank()) {
                        failedAction = step.action == null ? "" : step.action;
                        expectedOutcome = actionText;
                        observedOutcome = stepResult.message == null || stepResult.message.isBlank()
                                ? "Step failed without a detailed error message."
                                : stepResult.message;
                    }
                }
                String responseUrl = stepResponse == null ? null : stepResponse.currentUrl;
                turnCurrentUrl = stepResult.currentUrl == null || stepResult.currentUrl.isBlank()
                        ? responseUrl
                        : stepResult.currentUrl;
                if (stepResult.screenshotPath != null && !stepResult.screenshotPath.isBlank()) {
                    turnScreenshotPath = stepResult.screenshotPath;
                    lastScreenshotPath = stepResult.screenshotPath;
                }
                history.add("turn " + turn + " step " + (stepIndex + 1) + " - " + stepResult.action + " => " + stepResult.status +
                        (stepResult.message == null ? "" : " (" + stepResult.message + ")"));

                Map<String, Object> stepExecutionPayload = new HashMap<>();
                stepExecutionPayload.put("mode", "autonomous");
                stepExecutionPayload.put("turn", turn);
                stepExecutionPayload.put("stepIndex", stepIndex + 1);
                stepExecutionPayload.put("stepCount", boundedSteps.size());
                stepExecutionPayload.put("intentLabel", turnIntentLabel);
                stepExecutionPayload.put("step", step);
                stepExecutionPayload.put("evaluateText", evaluateText);
                stepExecutionPayload.put("actionText", actionText);
                stepExecutionPayload.put("result", stepResult);
                stepExecutionPayload.put("currentUrl", turnCurrentUrl);
                stepExecutionPayload.put("status", stepResult.status);
                AutomationSessionService.addEvent(
                        envelope.sessionId, envelope.projectId, envelope.testcaseId, envelope.userId, envelope.commandId, "autonomous_step_executed",
                        envelope.rawCommand,
                        stepExecutionPayload,
                        stepExecutionPayload,
                        stepResult.screenshotPath
                );

                // Continue executing the remaining planned steps for this turn even if one step fails.
                // This preserves full-turn execution semantics and richer diagnostics for generated scripts.
            }

            if (cancelled) break;
            if (turnResults.isEmpty()) {
                if (completionReason == null || completionReason.isBlank()) {
                    completionReason = "Autonomous run stopped because no step result was produced.";
                }
                break;
            }

            latestUrl = turnCurrentUrl;
            Map<String, Object> turnExecutionPayload = new HashMap<>();
            turnExecutionPayload.put("mode", "autonomous");
            turnExecutionPayload.put("turn", turn);
            turnExecutionPayload.put("intentLabel", turnIntentLabel);
            turnExecutionPayload.put("stepCount", turnResults.size());
            turnExecutionPayload.put("passedCount", turnPassed);
            turnExecutionPayload.put("failedCount", turnFailed);
            turnExecutionPayload.put("status", hasFailure ? "partial_failed" : "passed");
            turnExecutionPayload.put("steps", boundedSteps);
            turnExecutionPayload.put("results", turnResults);
            turnExecutionPayload.put("currentUrl", turnCurrentUrl);
            AutomationSessionService.addEvent(
                    envelope.sessionId, envelope.projectId, envelope.testcaseId, envelope.userId, envelope.commandId, "autonomous_turn_executed",
                    envelope.rawCommand,
                    turnExecutionPayload,
                    turnExecutionPayload,
                    turnScreenshotPath
            );

            Map<String, Object> plannedTurnEntry = new HashMap<>();
            plannedTurnEntry.put("turn", turn);
            plannedTurnEntry.put("remainingBudget", remaining);
            plannedTurnEntry.put("intentLabel", turnIntentLabel);
            plannedTurnEntry.put("steps", boundedSteps);
            plannedTurnEntry.put("status", hasFailure ? "partial_failed" : "passed");
            plannedTurnEntry.put("stepCount", turnResults.size());
            plannedTurnEntry.put("failedCount", turnFailed);
            plannedTurnEntry.put("screenshotPath", turnScreenshotPath);
            plannedTurns.add(plannedTurnEntry);

            if (hasFailure) {
                history.add("turn " + turn + " produced failures; re-planning with alternative strategy.");
                Map<String, Object> replanPayload = new HashMap<>();
                replanPayload.put("mode", "autonomous");
                replanPayload.put("turn", turn);
                replanPayload.put("intentLabel", turnIntentLabel);
                replanPayload.put("reason", "Previous step failed; trying alternative strategy.");
                replanPayload.put("failedAction", failedAction);
                replanPayload.put("expectedOutcome", expectedOutcome);
                replanPayload.put("observedOutcome", observedOutcome);
                AutomationSessionService.addEvent(
                        envelope.sessionId, envelope.projectId, envelope.testcaseId, envelope.userId, envelope.commandId, "autonomous_turn_replanned",
                        envelope.rawCommand,
                        replanPayload,
                        null,
                        turnScreenshotPath
                );
                continue;
            }
        }

        if (goalAchieved && (completionReason == null || completionReason.isBlank())) {
            completionReason = "Objective reached.";
        } else if (!goalAchieved && (completionReason == null || completionReason.isBlank())) {
            completionReason = cancelled
                    ? "Autonomous run stopped by user."
                    : "Autonomous run ended before objective could be confirmed.";
        }

        AutomationSessionService.touchState(
                envelope.sessionId,
                latestUrl,
                lastScreenshotPath,
                Map.of(
                        "mode", "autonomous",
                        "turns", turnCount,
                        "stepCount", executedSteps,
                        "goalAchieved", goalAchieved,
                        "cancelled", cancelled
                )
        );

        Map<String, Object> executionPayload = new HashMap<>();
        executionPayload.put("mode", "autonomous");
        executionPayload.put("objective", envelope.objective);
        executionPayload.put("goalAchieved", goalAchieved);
        executionPayload.put("completionReason", completionReason);
        executionPayload.put("iterations", turnCount);
        executionPayload.put("plannedTurns", plannedTurns);
        executionPayload.put("currentUrl", latestUrl);
        executionPayload.put("results", allResults);
        executionPayload.put("cancelled", cancelled);

        AutomationSessionService.addEvent(
                envelope.sessionId, envelope.projectId, envelope.testcaseId, envelope.userId, envelope.commandId, "command_executed",
                envelope.rawCommand,
                Map.of("mode", "autonomous", "objective", envelope.objective),
                executionPayload,
                lastScreenshotPath
        );
    }

    private static void appendCancelledEvent(CommandEnvelope envelope, String reason) {
        AutomationSessionService.addEvent(
                envelope.sessionId,
                envelope.projectId,
                envelope.testcaseId,
                envelope.userId,
                envelope.commandId,
                "command_cancelled",
                envelope.rawCommand,
                Map.of("mode", envelope.autonomousMode ? "autonomous" : "chat"),
                Map.of("cancelled", true, "reason", reason),
                null
        );
    }

    private static AutomationContracts.StepResult syntheticFailedStepResult(
            UUID commandId,
            AutomationContracts.ActionStep step,
            String currentUrl,
            String message
    ) {
        AutomationContracts.StepResult result = new AutomationContracts.StepResult();
        result.commandId = commandId == null ? "" : commandId.toString();
        result.stepId = step == null || step.id == null || step.id.isBlank() ? "step-runtime-failed" : step.id;
        result.action = step == null || step.action == null ? "" : step.action;
        result.status = "failed";
        result.currentUrl = currentUrl == null ? "" : currentUrl;
        result.selectorUsed = step != null && step.selector != null ? step.selector : null;
        result.highlight = null;
        result.message = message == null || message.isBlank() ? "Step failed due to runtime error." : message;
        result.screenshotPath = null;
        result.durationMs = 0L;
        return result;
    }

    public static void getSession(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID sessionId = UUID.fromString(ctx.pathParam("sessionId"));
        Map<String, Object> session = AutomationSessionService.getSession(sessionId, projectId, userId)
                .orElseThrow(io.javalin.http.NotFoundResponse::new);
        SessionCommandState state = commandStates.get(sessionId);
        Map<String, Object> runtime = new HashMap<>();
        runtime.put("activeCommandId", state == null || state.activeCommandId == null ? null : state.activeCommandId.toString());
        runtime.put("queuedCount", state == null ? 0 : state.queue.size());
        runtime.put("isRunning", state != null && state.activeCommandId != null);
        session.put("runtime", runtime);
        ctx.json(session);
    }

    public static void stopActiveCommand(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID sessionId = UUID.fromString(ctx.pathParam("sessionId"));
        Map<String, Object> session = AutomationSessionService.getSession(sessionId, projectId, userId)
                .orElseThrow(io.javalin.http.NotFoundResponse::new);
        UUID testcaseId = UUID.fromString(String.valueOf(session.get("testcaseId")));
        SessionCommandState state = commandStates.get(sessionId);
        boolean stopRequested = false;
        String activeCommandId = null;
        if (state != null && state.activeCommandId != null && state.activeCancelSignal != null) {
            state.activeCancelSignal.set(true);
            stopRequested = true;
            activeCommandId = state.activeCommandId.toString();
            AutomationSessionService.addEvent(
                    sessionId,
                    projectId,
                    testcaseId,
                    userId,
                    state.activeCommandId,
                    "command_stop_requested",
                    "stop_current_command",
                    Map.of("requested", true),
                    null,
                    null
            );
        }
        Map<String, Object> response = new HashMap<>();
        response.put("stopRequested", stopRequested);
        response.put("activeCommandId", activeCommandId);
        response.put("queuedCount", state == null ? 0 : state.queue.size());
        ctx.status(202).json(response);
    }

    public static void stream(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID sessionId = UUID.fromString(ctx.pathParam("sessionId"));
        AutomationSessionService.getSession(sessionId, projectId, userId)
                .orElseThrow(io.javalin.http.NotFoundResponse::new);
        Map<String, Object> state;
        try {
            state = AutomationAgentClient.getSessionState(sessionId);
        } catch (Exception e) {
            // Backend may have session persisted while in-memory agent session was lost (restart/crash).
            ctx.status(200).json(Map.of(
                    "status", "disconnected",
                    "error", "Agent session unavailable. Start a new automation session."
            ));
            return;
        }
        Object screenshotPath = state.get("lastScreenshotPath");
        if (screenshotPath instanceof String path && !path.isBlank()) {
            try {
                byte[] bytes = Files.readAllBytes(Path.of(path));
                String dataUrl = "data:image/png;base64," + Base64.getEncoder().encodeToString(bytes);
                state.put("screenshotDataUrl", dataUrl);
            } catch (Exception ignored) {}
        }
        ctx.json(state);
    }

    public static void live(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID sessionId = UUID.fromString(ctx.pathParam("sessionId"));
        AutomationSessionService.getSession(sessionId, projectId, userId)
                .orElseThrow(io.javalin.http.NotFoundResponse::new);
        try {
            HttpRequest.Builder builder = HttpRequest.newBuilder()
                    .uri(URI.create(com.bettercases.Config.AUTOMATION_AGENT_BASE_URL + "/internal/sessions/" + sessionId + "/live"))
                    .GET();
            if (!com.bettercases.Config.AUTOMATION_AGENT_SHARED_TOKEN.isBlank()) {
                builder.header("x-agent-token", com.bettercases.Config.AUTOMATION_AGENT_SHARED_TOKEN);
            }
            HttpResponse<InputStream> upstream = streamClient.send(builder.build(), HttpResponse.BodyHandlers.ofInputStream());
            if (upstream.statusCode() < 200 || upstream.statusCode() >= 300) {
                ctx.status(upstream.statusCode()).result("Live stream unavailable");
                return;
            }
            String contentType = upstream.headers().firstValue("Content-Type")
                    .orElse("multipart/x-mixed-replace; boundary=frame");
            ctx.contentType(contentType);
            ctx.header("Cache-Control", "no-cache, no-store, must-revalidate");
            ctx.header("Pragma", "no-cache");
            ctx.header("Expires", "0");
            try (InputStream in = upstream.body()) {
                in.transferTo(ctx.res().getOutputStream());
                ctx.res().getOutputStream().flush();
            }
        } catch (Exception e) {
            ctx.status(502).json(Map.of("error", "Failed to proxy live stream"));
        }
    }

    public static void downloadLatestTrace(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID sessionId = UUID.fromString(ctx.pathParam("sessionId"));
        AutomationSessionService.getSession(sessionId, projectId, userId)
                .orElseThrow(io.javalin.http.NotFoundResponse::new);
        Map<String, Object> state = AutomationAgentClient.getSessionState(sessionId);
        String tracePath = state.get("lastTracePath") instanceof String s ? s : null;
        if (tracePath == null || tracePath.isBlank()) {
            throw new io.javalin.http.NotFoundResponse("Trace artifact not found");
        }
        try {
            byte[] bytes = Files.readAllBytes(Path.of(tracePath));
            ctx.contentType("application/zip");
            ctx.header("Cache-Control", "no-cache, no-store, must-revalidate");
            ctx.header("Pragma", "no-cache");
            ctx.header("Expires", "0");
            ctx.header("Content-Disposition", "attachment; filename=\"automation-trace-" + sessionId + ".zip\"");
            ctx.result(bytes);
        } catch (Exception e) {
            throw new io.javalin.http.NotFoundResponse("Trace artifact not found");
        }
    }

    public static void finalizeSession(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID sessionId = UUID.fromString(ctx.pathParam("sessionId"));
        Map<String, Object> session = AutomationSessionService.getSession(sessionId, projectId, userId)
                .orElseThrow(io.javalin.http.NotFoundResponse::new);
        UUID testcaseId = UUID.fromString(String.valueOf(session.get("testcaseId")));
        AutomationContracts.FinalizeBody body = ctx.bodyAsClass(AutomationContracts.FinalizeBody.class);

        List<Map<String, Object>> events = AutomationSessionService.listEvents(sessionId, 5000);
        String generatedScript = AutomationScriptBuilderService.buildPlaywrightScript(
                body != null ? body.testName : null,
                events
        );
        String scriptLanguage = "playwright-ts";
        boolean shouldGenerateSteps = shouldAutoGenerateSteps(projectId, userId);
        List<Map<String, Object>> generatedSteps = shouldGenerateSteps
                ? AutomationScriptBuilderService.buildTestSteps(events)
                : null;
        String scriptToSave = generatedScript;
        if (body != null && body.script != null && !body.script.trim().isBlank()) {
            scriptToSave = body.script.trim();
        }
        List<Map<String, Object>> stepsToSave = generatedSteps;
        if (shouldGenerateSteps && body != null && body.steps != null) {
            List<Map<String, Object>> sanitized = new java.util.ArrayList<>();
            for (Map<String, Object> candidate : body.steps) {
                if (candidate == null) continue;
                String action = candidate.get("action") == null ? "" : String.valueOf(candidate.get("action")).trim();
                String expectedResult = candidate.get("expectedResult") == null ? "" : String.valueOf(candidate.get("expectedResult")).trim();
                if (action.isBlank() && expectedResult.isBlank()) continue;
                Map<String, Object> item = new java.util.HashMap<>();
                item.put("action", action);
                item.put("expectedResult", expectedResult);
                sanitized.add(item);
            }
            for (int i = 0; i < sanitized.size(); i++) {
                sanitized.get(i).put("stepNumber", i + 1);
            }
            stepsToSave = sanitized;
        }
        AutomationSessionService.finalizeIntoTestcase(
                projectId,
                testcaseId,
                userId,
                body != null && body.framework != null ? body.framework : "Playwright",
                body != null ? body.repo : null,
                body != null ? body.path : null,
                body != null && body.testName != null ? body.testName : "Generated Test",
                scriptToSave,
                scriptLanguage,
                stepsToSave
        );
        AutomationSessionService.markSessionEnded(sessionId, "completed");
        SessionCommandState state = commandStates.remove(sessionId);
        if (state != null && state.activeCancelSignal != null) {
            state.activeCancelSignal.set(true);
            state.queue.clear();
        }
        AutomationAgentClient.closeSession(sessionId);
        try {
            AuditService.logActivity(userId, projectId, "automation_session_finalized", "testcase", testcaseId.toString(), null);
        } catch (Exception ignored) {}
        ctx.json(Map.of("status", "ok", "script", scriptToSave));
    }

    public static void manualAction(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID sessionId = UUID.fromString(ctx.pathParam("sessionId"));
        Map<String, Object> session = AutomationSessionService.getSession(sessionId, projectId, userId)
                .orElseThrow(io.javalin.http.NotFoundResponse::new);
        UUID testcaseId = UUID.fromString(String.valueOf(session.get("testcaseId")));
        AutomationContracts.ManualActionBody body = ctx.bodyAsClass(AutomationContracts.ManualActionBody.class);
        if (body == null || body.actionType == null || body.actionType.isBlank()) {
            ctx.status(400).json(Map.of("error", "actionType is required"));
            return;
        }
        Map<String, Object> payload = new HashMap<>();
        payload.put("actionType", body.actionType);
        payload.put("xRatio", body.xRatio);
        payload.put("yRatio", body.yRatio);
        payload.put("toXRatio", body.toXRatio);
        payload.put("toYRatio", body.toYRatio);
        payload.put("deltaX", body.deltaX);
        payload.put("deltaY", body.deltaY);
        payload.put("text", body.text);
        payload.put("key", body.key);

        Map<String, Object> result = AutomationAgentClient.manualAction(sessionId, payload);
        String screenshotPath = result.get("screenshotPath") instanceof String s ? s : null;
        String currentUrl = result.get("currentUrl") instanceof String s ? s : null;
        AutomationSessionService.touchState(
                sessionId,
                currentUrl,
                screenshotPath,
                Map.of("manualActionType", body.actionType)
        );

        Map<String, Object> parsedAction = new HashMap<>();
        if ("click".equals(body.actionType)) {
            parsedAction.put("action", "click");
            if (result.get("selector") instanceof String selector && !selector.isBlank()) {
                parsedAction.put("selector", selector);
            }
            if (result.get("targetText") instanceof String targetText && !targetText.isBlank()) {
                parsedAction.put("targetText", targetText);
            }
            if (result.get("targetHtml") instanceof String targetHtml && !targetHtml.isBlank()) {
                parsedAction.put("targetHtml", targetHtml);
            }
            parsedAction.put("xRatio", body.xRatio);
            parsedAction.put("yRatio", body.yRatio);
        } else if ("drag".equals(body.actionType)) {
            parsedAction.put("action", "drag");
            if (result.get("startSelector") instanceof String startSelector && !startSelector.isBlank()) {
                parsedAction.put("startSelector", startSelector);
            }
            if (result.get("endSelector") instanceof String endSelector && !endSelector.isBlank()) {
                parsedAction.put("endSelector", endSelector);
            }
            parsedAction.put("xRatio", body.xRatio);
            parsedAction.put("yRatio", body.yRatio);
            parsedAction.put("toXRatio", body.toXRatio);
            parsedAction.put("toYRatio", body.toYRatio);
        } else if ("scroll".equals(body.actionType)) {
            parsedAction.put("action", "scroll");
            parsedAction.put("deltaX", body.deltaX);
            parsedAction.put("deltaY", body.deltaY);
        } else if ("type".equals(body.actionType)) {
            parsedAction.put("action", "type");
            if (result.get("selector") instanceof String selector && !selector.isBlank()) {
                parsedAction.put("selector", selector);
            } else {
                parsedAction.put("selector", "activeElement");
            }
            if (result.get("targetText") instanceof String targetText && !targetText.isBlank()) {
                parsedAction.put("targetText", targetText);
            }
            if (result.get("targetHtml") instanceof String targetHtml && !targetHtml.isBlank()) {
                parsedAction.put("targetHtml", targetHtml);
            }
            parsedAction.put("value", body.text == null ? "" : body.text);
        } else if ("press".equals(body.actionType)) {
            parsedAction.put("action", "press");
            parsedAction.put("key", body.key == null ? "Enter" : body.key);
            if (result.get("selector") instanceof String selector && !selector.isBlank()) {
                parsedAction.put("selector", selector);
            }
            if (result.get("targetText") instanceof String targetText && !targetText.isBlank()) {
                parsedAction.put("targetText", targetText);
            }
            if (result.get("targetHtml") instanceof String targetHtml && !targetHtml.isBlank()) {
                parsedAction.put("targetHtml", targetHtml);
            }
        }

        AutomationSessionService.addEvent(
                sessionId,
                projectId,
                testcaseId,
                userId,
                UUID.randomUUID(),
                "manual_action_executed",
                "manual:" + body.actionType,
                parsedAction,
                result,
                screenshotPath
        );
        ctx.json(result);
    }

    public static void runPlaywrightScript(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID sessionId = UUID.fromString(ctx.pathParam("sessionId"));
        Map<String, Object> session = AutomationSessionService.getSession(sessionId, projectId, userId)
                .orElseThrow(io.javalin.http.NotFoundResponse::new);
        UUID testcaseId = UUID.fromString(String.valueOf(session.get("testcaseId")));
        AutomationContracts.RunScriptBody body = ctx.bodyAsClass(AutomationContracts.RunScriptBody.class);
        String script = body != null && body.script != null ? body.script.trim() : "";
        if (script.isBlank()) {
            ctx.status(400).json(Map.of("error", "script is required"));
            return;
        }
        String startUrl = body != null && body.startUrl != null && !body.startUrl.isBlank() ? body.startUrl : null;
        UUID executionId = UUID.randomUUID();
        Integer requestedDelay = body != null ? body.actionDelayMs : null;
        Integer actionDelayMs = requestedDelay == null ? 0 : Math.max(0, Math.min(5000, requestedDelay));
        Map<String, Object> result = AutomationAgentClient.runPlaywrightScriptInSession(sessionId, executionId, script, startUrl, actionDelayMs);
        String currentUrl = result.get("currentUrl") instanceof String s ? s : null;
        String screenshotPath = result.get("screenshotPath") instanceof String s ? s : null;
        String tracePath = result.get("tracePath") instanceof String s ? s : null;
        String videoPath = result.get("videoPath") instanceof String s ? s : null;
        String runStatus = result.get("status") instanceof String s ? s : "failed";
        String errorMessage = result.get("errorMessage") instanceof String s ? s : null;

        AutomationSessionService.touchState(
                sessionId,
                currentUrl,
                screenshotPath,
                Map.of(
                        "scriptRun", true,
                        "scriptVersion", body != null && body.scriptVersion != null ? body.scriptVersion : 0,
                        "status", runStatus,
                        "tracePath", tracePath == null ? "" : tracePath,
                        "videoPath", videoPath == null ? "" : videoPath
                )
        );

        Map<String, Object> parsedAction = new HashMap<>();
        parsedAction.put("action", "run_playwright_script");
        parsedAction.put("scriptVersion", body != null ? body.scriptVersion : null);
        parsedAction.put("startUrl", startUrl == null ? "" : startUrl);

        Map<String, Object> executionResult = new HashMap<>();
        executionResult.put("status", runStatus);
        executionResult.put("currentUrl", currentUrl == null ? "" : currentUrl);
        executionResult.put("screenshotPath", screenshotPath == null ? "" : screenshotPath);
        executionResult.put("tracePath", tracePath == null ? "" : tracePath);
        executionResult.put("videoPath", videoPath == null ? "" : videoPath);
        executionResult.put("errorMessage", errorMessage == null ? "" : errorMessage);
        executionResult.put("durationMs", result.get("durationMs"));
        executionResult.put("logs", result.get("logs"));

        AutomationSessionService.addEvent(
                sessionId,
                projectId,
                testcaseId,
                userId,
                executionId,
                "playwright_script_executed",
                "playwright_script_run",
                parsedAction,
                executionResult,
                screenshotPath
        );
        ctx.json(result);
    }

    public static void reset(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID sessionId = UUID.fromString(ctx.pathParam("sessionId"));
        Map<String, Object> session = AutomationSessionService.getSession(sessionId, projectId, userId)
                .orElseThrow(io.javalin.http.NotFoundResponse::new);
        UUID testcaseId = UUID.fromString(String.valueOf(session.get("testcaseId")));
        AutomationContracts.StartSessionBody body = ctx.bodyAsClass(AutomationContracts.StartSessionBody.class);
        String startUrl = body != null && body.startUrl != null && !body.startUrl.isBlank() ? body.startUrl : null;
        Map<String, Object> resetResult = AutomationAgentClient.resetSession(sessionId, startUrl);
        String currentUrl = resetResult.get("currentUrl") instanceof String s ? s : null;
        AutomationSessionService.touchState(
                sessionId,
                currentUrl,
                null,
                Map.of("sessionReset", true)
        );
        AutomationSessionService.addEvent(
                sessionId,
                projectId,
                testcaseId,
                userId,
                UUID.randomUUID(),
                "session_reset",
                "session_reset",
                Map.of("startUrl", startUrl == null ? "" : startUrl),
                resetResult,
                null
        );
        ctx.json(resetResult);
    }

    public static void cancel(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID sessionId = UUID.fromString(ctx.pathParam("sessionId"));
        Map<String, Object> session = AutomationSessionService.getSession(sessionId, projectId, userId)
                .orElseThrow(io.javalin.http.NotFoundResponse::new);
        UUID testcaseId = UUID.fromString(String.valueOf(session.get("testcaseId")));
        SessionCommandState state = commandStates.remove(sessionId);
        if (state != null && state.activeCancelSignal != null) {
            state.activeCancelSignal.set(true);
            state.queue.clear();
        }
        AutomationSessionService.markSessionEnded(sessionId, "cancelled");
        AutomationAgentClient.closeSession(sessionId);
        try {
            AuditService.logActivity(userId, projectId, "automation_session_cancelled", "testcase", testcaseId.toString(), null);
        } catch (Exception ignored) {}
        ctx.status(204);
    }

    private static String describeEvaluation(AutomationContracts.ActionStep step) {
        String target = friendlyStepTarget(step);
        if (step == null || step.action == null) {
            return "Thinking: I will inspect the current DOM structure and visible UI layout, then pick the safest next interaction using stable locators.";
        }
        return switch (step.action) {
            case "navigate" -> "Thinking: I will validate current context first, then navigate only if it moves us toward the objective. " +
                    "I will preserve user-like flow and avoid unnecessary redirects.";
            case "click" -> "Thinking: I will inspect DOM + screen layout, locate " + target + " using role/label/testid/text priority, " +
                    "and verify it is actionable before click. If missing, I will explore nearby controls and alternate visible labels.";
            case "type" -> {
                if (looksLikeDropdown(step)) {
                    yield "Thinking: I will confirm " + target + " is a selection control from DOM semantics and visual layout, " +
                            "then choose the intended option. If exact label is missing, I will search equivalent options in the same section.";
                }
                yield "Thinking: I will confirm " + target + " is the intended input via DOM + visible layout, then type as a real user would. " +
                        "If not found, I will explore related input fields with equivalent labels/placeholders.";
            }
            case "assert_visible" -> "Thinking: I will verify " + target + " is visible using concrete on-screen evidence. " +
                    "If it is not found directly, I will inspect nearby UI regions and alternate labels before concluding failure.";
            case "assert_text" -> "Thinking: I will validate expected text using DOM-grounded checks and visible content context" +
                    (step.expectedText != null && !step.expectedText.isBlank() ? " (" + step.expectedText + ")." : ".") +
                    " If exact match is absent, I will check equivalent nearby text candidates.";
            case "assert_clickable" -> "Thinking: I will confirm " + target + " is visible, enabled, and interactable in current layout. " +
                    "If not immediately found, I will probe equivalent actionable controls in the same UI context.";
            default -> "Thinking: I will analyze DOM + layout, choose stable locators, and proceed with the safest next action.";
        };
    }

    private static String describeAction(AutomationContracts.ActionStep step) {
        String target = friendlyStepTarget(step);
        if (step == null || step.action == null) {
            return "Action: I will execute the next planned interaction.";
        }
        return switch (step.action) {
            case "navigate" -> "Action: open " + (step.url == null || step.url.isBlank() ? "the required URL." : step.url + ".");
            case "click" -> "Action: click " + target + ".";
            case "type" -> {
                if (looksLikeDropdown(step)) {
                    String option = step.value == null || step.value.isBlank() ? "the required option" : "\"" + step.value + "\"";
                    yield "Action: select " + option + " from " + target + ".";
                }
                String value = step.value == null || step.value.isBlank() ? "the required value" : "\"" + step.value + "\"";
                yield "Action: type " + value + " into " + target + ".";
            }
            case "assert_visible" -> "Action: validate that " + target + " is visible.";
            case "assert_text" -> "Action: validate that the expected text appears on the page.";
            case "assert_clickable" -> "Action: validate that " + target + " is clickable.";
            default -> "Action: execute the planned step.";
        };
    }

    private static String friendlyStepTarget(AutomationContracts.ActionStep step) {
        if (step == null) return "the target element";
        if (step.targetDescription != null && !step.targetDescription.isBlank()) return "\"" + step.targetDescription + "\"";
        if (step.expectedText != null && !step.expectedText.isBlank()) return "\"" + step.expectedText + "\"";
        if (step.selector != null && !step.selector.isBlank()) return "\"" + step.selector + "\"";
        return "the target element";
    }

    private static boolean looksLikeDropdown(AutomationContracts.ActionStep step) {
        if (step == null) return false;
        String selector = step.selector == null ? "" : step.selector.toLowerCase();
        String target = step.targetDescription == null ? "" : step.targetDescription.toLowerCase();
        return selector.contains("select")
                || selector.contains("combobox")
                || target.contains("dropdown")
                || target.contains("select");
    }

    private static String inferIntentLabel(String objective, List<AutomationContracts.ActionStep> steps) {
        if (steps == null || steps.isEmpty()) return "No actionable intent";
        String objectiveText = objective == null ? "" : objective.toLowerCase();
        boolean hasType = steps.stream().anyMatch(s -> s != null && "type".equals(s.action));
        boolean hasClick = steps.stream().anyMatch(s -> s != null && "click".equals(s.action));
        boolean hasNavigate = steps.stream().anyMatch(s -> s != null && "navigate".equals(s.action));
        boolean hasAssert = steps.stream().anyMatch(s -> s != null && s.action != null && s.action.startsWith("assert"));
        if (objectiveText.contains("form") && hasType && hasClick) return "Fill and submit form";
        if (hasNavigate && (hasType || hasClick)) return "Navigate and interact";
        if (hasType && hasClick) return "Input and action";
        if (hasType) return "Data entry";
        if (hasClick) return "UI interaction";
        if (hasAssert) return "Verification";
        return "Autonomous action";
    }

    private static String buildDomPlanningContext(Map<String, Object> liveState) {
        if (liveState == null) return "";
        Object rawDomSummary = liveState.get("domSummary");
        if (!(rawDomSummary instanceof Map<?, ?> domSummary)) return "";
        StringBuilder sb = new StringBuilder();
        appendContextField(sb, "title", domSummary.get("title"));
        appendContextField(sb, "url", domSummary.get("url"));
        appendContextField(sb, "headings", domSummary.get("headings"));
        appendContextField(sb, "forms", domSummary.get("forms"));
        appendContextField(sb, "visibleButtons", domSummary.get("visibleButtons"));
        appendContextField(sb, "visibleLinks", domSummary.get("visibleLinks"));
        appendContextField(sb, "visibleInputs", domSummary.get("visibleInputs"));
        appendContextField(sb, "buttonLabels", domSummary.get("buttonLabels"));
        appendContextField(sb, "linkLabels", domSummary.get("linkLabels"));
        appendContextField(sb, "inputHints", domSummary.get("inputHints"));
        String context = sb.toString().trim();
        return context.length() > 2800 ? context.substring(0, 2800) : context;
    }

    private static void appendContextField(StringBuilder sb, String key, Object value) {
        if (sb == null || key == null || key.isBlank() || value == null) return;
        String normalized;
        if (value instanceof List<?> list) {
            normalized = list.stream()
                    .filter(item -> item != null && !String.valueOf(item).isBlank())
                    .map(String::valueOf)
                    .limit(16)
                    .reduce((a, b) -> a + ", " + b)
                    .orElse("");
        } else {
            normalized = String.valueOf(value).trim();
        }
        if (normalized.isBlank()) return;
        if (sb.length() > 0) sb.append('\n');
        sb.append("- ").append(key).append(": ").append(normalized);
    }

    private static String asSafeText(Object value) {
        if (value == null) return "";
        String out = String.valueOf(value).trim();
        return "null".equalsIgnoreCase(out) ? "" : out;
    }

    private static boolean shouldAutoGenerateSteps(UUID projectId, UUID userId) {
        try {
            Optional<Map<String, Object>> project = ProjectService.getProject(projectId, userId);
            if (project.isEmpty()) return true;
            Object rawSettings = project.get().get("settings");
            if (!(rawSettings instanceof String settingsJson) || settingsJson.isBlank()) return true;
            Map<String, Object> settings = mapper.readValue(settingsJson, new TypeReference<>() {});
            Object aiObject = settings.get("ai");
            if (!(aiObject instanceof Map<?, ?> aiMap)) return true;
            Object flag = aiMap.get("autoGenerateTestSteps");
            if (flag instanceof Boolean enabled) return enabled;
            return true;
        } catch (Exception ignored) {
            return true;
        }
    }

    private AutomationSessionHandler() {}
}
