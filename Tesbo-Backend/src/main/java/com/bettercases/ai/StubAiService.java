package com.bettercases.ai;

import java.util.Collections;
import java.util.List;

/**
 * Stub implementation: returns empty or placeholder data.
 * Replace with real provider (OpenAI/Claude) when API key is configured.
 */
public final class StubAiService implements AiService {
    @Override
    public List<GeneratedTestCase> generateTestCases(GenerateRequest request) {
        String trimmedStory = request.userStory() != null ? request.userStory().trim() : "";
        String titleSeed = trimmedStory.isEmpty() ? "feature behavior" : trimmedStory;
        if (titleSeed.length() > 40) titleSeed = titleSeed.substring(0, 40) + "…";
        int requestedCount = Math.max(1, request.count());

        String scenarioType;
        if (request.includeBoundary()) {
            scenarioType = "Boundary and edge handling";
        } else if (request.includeNegativeFlow()) {
            scenarioType = "Negative flow";
        } else if (request.includeHappyFlow()) {
            scenarioType = "Happy flow";
        } else {
            scenarioType = "Core functional flow";
        }

        java.util.ArrayList<GeneratedTestCase> generated = new java.util.ArrayList<>();
        for (int i = 1; i <= requestedCount; i++) {
            java.util.ArrayList<String> tags = new java.util.ArrayList<>();
            tags.add("functional");
            if (request.includeHappyFlow()) tags.add("happy-flow");
            if (request.includeNegativeFlow()) tags.add("negative-flow");
            if (request.includeBoundary()) tags.add("bva");
            if (request.includeMultiTab()) tags.add("multi-tab");
            if (request.includeCrossBrowser()) tags.add("cross-browser");

            generated.add(new GeneratedTestCase(
                    "Scenario " + i + ": " + scenarioType + " for " + titleSeed,
                    "User has required permissions and test data is available",
                    "[{\"stepNumber\":1,\"action\":\"Prepare preconditions for scenario " + i + "\",\"expectedResult\":\"Preconditions are satisfied\"}," +
                            "{\"stepNumber\":2,\"action\":\"Execute the key workflow for scenario " + i + "\",\"expectedResult\":\"System behaves as expected\"}," +
                            "{\"stepNumber\":3,\"action\":\"Validate outcome and logs\",\"expectedResult\":\"Expected result is captured and auditable\"}]",
                    "Workflow is validated for scenario " + i,
                    i == 1 ? "P1" : "P2",
                    tags
            ));
        }
        return generated;
    }

    @Override
    public String improveTestCase(String testCaseJson, String instruction) {
        return testCaseJson;
    }

    @Override
    public List<SuggestedCase> suggestCoverageGaps(String suiteContext) {
        return Collections.emptyList();
    }

    @Override
    public List<DuplicatePair> detectDuplicates(List<String> testcaseIds) {
        return Collections.emptyList();
    }
}
