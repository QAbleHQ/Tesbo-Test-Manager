package com.bettercases.automation;

import java.util.List;
import java.util.Map;

public final class AutomationContracts {
    public static class StartSessionBody {
        public String startUrl;
    }

    public static class CommandBody {
        public String command;
    }

    public static class FinalizeBody {
        public String testName;
        public String framework;
        public String repo;
        public String path;
        public String script;
        public List<Map<String, Object>> steps;
    }

    public static class ManualActionBody {
        public String actionType;
        public Double xRatio;
        public Double yRatio;
        public Double toXRatio;
        public Double toYRatio;
        public Double deltaX;
        public Double deltaY;
        public String text;
        public String key;
    }

    public static class RunScriptBody {
        public String script;
        public Integer scriptVersion;
        public String startUrl;
    }

    public static class ActionPlan {
        public String commandId;
        public List<ActionStep> steps;
        public String clarificationQuestion;
        public boolean requiresClarification;
        public boolean goalAchieved;
        public String completionReason;
    }

    public static class ActionStep {
        public String id;
        public String action;
        public String url;
        public String selector;
        public String targetDescription;
        public String value;
        public String expectedText;
        public Integer timeoutMs;
    }

    public static class AgentExecuteResponse {
        public String sessionId;
        public String commandId;
        public String currentUrl;
        public List<StepResult> results;
    }

    public static class StepResult {
        public String commandId;
        public String stepId;
        public String action;
        public String status;
        public String currentUrl;
        public String selectorUsed;
        public java.util.Map<String, Object> highlight;
        public String message;
        public String screenshotPath;
        public Long durationMs;
    }

    private AutomationContracts() {}
}
