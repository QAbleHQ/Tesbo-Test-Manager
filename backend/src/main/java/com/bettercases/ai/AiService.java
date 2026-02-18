package com.bettercases.ai;

import java.util.List;

/**
 * Provider-agnostic AI adapter for test case generation, improvement, and analysis.
 * Implement with OpenAI/Claude/etc and wire via config.
 */
public interface AiService {
    /** Generate draft test cases from user story / acceptance criteria. */
    List<GeneratedTestCase> generateTestCases(GenerateRequest request);

    /** Improve/refactor an existing test case (steps, clarity). */
    String improveTestCase(String testCaseJson, String instruction);

    /** Suggest coverage gaps for a suite/plan. */
    List<SuggestedCase> suggestCoverageGaps(String suiteContext);

    /** Detect duplicate or near-duplicate test cases. */
    List<DuplicatePair> detectDuplicates(List<String> testcaseIds);

    record GenerateRequest(
            String userStory,
            String acceptanceCriteria,
            String customPrompt,
            String style,
            int count,
            boolean includeHappyFlow,
            boolean includeNegativeFlow,
            boolean includeMultiTab,
            boolean includeCrossBrowser,
            boolean includeBoundary
    ) {}

    record GeneratedTestCase(String title, String preconditions, String stepsJson, String expectedSummary, String priority, List<String> tags) {}

    record SuggestedCase(String title, String reason, String stepsJson) {}

    record DuplicatePair(String id1, String id2, double score, String mergeSuggestion) {}
}
