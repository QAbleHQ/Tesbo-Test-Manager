package com.bettercases.automation;

import java.util.List;

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
    }

    public static class ActionPlan {
        public String commandId;
        public List<ActionStep> steps;
        public String clarificationQuestion;
        public boolean requiresClarification;
    }

    public static class ActionStep {
        public String id;
        public String action;
        public String url;
        public String selector;
        public String value;
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
        public String message;
        public String screenshotPath;
        public Long durationMs;
    }

    private AutomationContracts() {}
}
