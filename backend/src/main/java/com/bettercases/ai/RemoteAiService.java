package com.bettercases.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class RemoteAiService implements AiService {
    public enum Provider {
        OPENAI,
        ANTHROPIC
    }

    private static final ObjectMapper mapper = new ObjectMapper();
    private static final String OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
    private static final String ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
    private static final String DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
    private static final String DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";

    private final HttpClient client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(15))
            .build();
    private final Provider provider;
    private final String apiKey;
    private final String model;

    public RemoteAiService(Provider provider, String apiKey, String model) {
        this.provider = provider;
        this.apiKey = apiKey;
        this.model = model;
    }

    @Override
    public List<GeneratedTestCase> generateTestCases(GenerateRequest request) {
        String prompt = buildGenerationPrompt(request);
        String rawContent;
        if (provider == Provider.OPENAI) {
            rawContent = callOpenAi(prompt);
        } else {
            rawContent = callAnthropic(prompt);
        }
        List<GeneratedTestCase> parsed = parseGeneratedCases(rawContent, request.count());
        if (!parsed.isEmpty()) return parsed;
        throw new RuntimeException("AI provider returned an invalid response format");
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

    private String callOpenAi(String prompt) {
        ObjectNode body = mapper.createObjectNode();
        body.put("model", model != null && !model.isBlank() ? model : DEFAULT_OPENAI_MODEL);
        ArrayNode messages = body.putArray("messages");
        messages.addObject()
                .put("role", "system")
                .put("content", "You are a senior QA engineer generating high-quality structured test cases.");
        messages.addObject().put("role", "user").put("content", prompt);
        body.put("temperature", 0.2);
        String requestPayload = body.toString();
        String activeModel = body.path("model").asText(DEFAULT_OPENAI_MODEL);
        AiLoggers.providerInfo(
                "provider_request provider=openai endpoint=/v1/chat/completions model=" + activeModel +
                        " payload=" + AiLoggers.truncate(requestPayload, 2500)
        );

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(OPENAI_ENDPOINT))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + apiKey)
                .timeout(Duration.ofSeconds(60))
                .POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8))
                .build();

        String response = sendRequest(request);
        AiLoggers.providerInfo(
                "provider_response provider=openai model=" + activeModel +
                        " body=" + AiLoggers.truncate(response, 2500)
        );
        try {
            JsonNode root = mapper.readTree(response);
            JsonNode content = root.path("choices").path(0).path("message").path("content");
            if (content.isMissingNode() || content.isNull() || content.asText().isBlank()) {
                throw new RuntimeException("OpenAI returned empty completion");
            }
            return content.asText();
        } catch (Exception e) {
            throw new RuntimeException("Failed to parse OpenAI response", e);
        }
    }

    private String callAnthropic(String prompt) {
        ObjectNode body = mapper.createObjectNode();
        body.put("model", model != null && !model.isBlank() ? model : DEFAULT_ANTHROPIC_MODEL);
        body.put("max_tokens", 3000);
        body.put("temperature", 0.2);
        body.put("system", "You are a senior QA engineer generating high-quality structured test cases.");
        ArrayNode messages = body.putArray("messages");
        messages.addObject()
                .put("role", "user")
                .put("content", prompt);
        String requestPayload = body.toString();
        String activeModel = body.path("model").asText(DEFAULT_ANTHROPIC_MODEL);
        AiLoggers.providerInfo(
                "provider_request provider=anthropic endpoint=/v1/messages model=" + activeModel +
                        " payload=" + AiLoggers.truncate(requestPayload, 2500)
        );

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(ANTHROPIC_ENDPOINT))
                .header("Content-Type", "application/json")
                .header("x-api-key", apiKey)
                .header("anthropic-version", "2023-06-01")
                .timeout(Duration.ofSeconds(60))
                .POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8))
                .build();

        String response = sendRequest(request);
        AiLoggers.providerInfo(
                "provider_response provider=anthropic model=" + activeModel +
                        " body=" + AiLoggers.truncate(response, 2500)
        );
        try {
            JsonNode root = mapper.readTree(response);
            JsonNode contentArray = root.path("content");
            if (!contentArray.isArray()) throw new RuntimeException("Anthropic content not found");
            StringBuilder sb = new StringBuilder();
            for (JsonNode part : contentArray) {
                if ("text".equals(part.path("type").asText())) {
                    sb.append(part.path("text").asText(""));
                }
            }
            String text = sb.toString().trim();
            if (text.isBlank()) throw new RuntimeException("Anthropic returned empty completion");
            return text;
        } catch (Exception e) {
            throw new RuntimeException("Failed to parse Anthropic response", e);
        }
    }

    private String sendRequest(HttpRequest request) {
        long startedAt = System.currentTimeMillis();
        try {
            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            int code = response.statusCode();
            long elapsed = System.currentTimeMillis() - startedAt;
            if (code >= 200 && code < 300) {
                AiLoggers.providerInfo(
                        "provider_http_success uri=" + request.uri() +
                                " status=" + code +
                                " elapsedMs=" + elapsed
                );
                return response.body();
            }
            String body = response.body();
            String errorDetail = extractProviderErrorMessage(body);
            AiLoggers.providerWarn(
                    "provider_http_failure uri=" + request.uri() +
                            " status=" + code +
                            " elapsedMs=" + elapsed +
                            " body=" + AiLoggers.truncate(body, 1200)
            );
            throw new RuntimeException("AI provider error (HTTP " + code + "): " + errorDetail);
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            throw new RuntimeException("AI request interrupted", ie);
        } catch (RuntimeException re) {
            throw re;
        } catch (Exception e) {
            long elapsed = System.currentTimeMillis() - startedAt;
            AiLoggers.providerError(
                    "provider_http_exception uri=" + request.uri() +
                            " elapsedMs=" + elapsed,
                    e
            );
            throw new RuntimeException("AI network error: " + e.getMessage(), e);
        }
    }

    private String extractProviderErrorMessage(String responseBody) {
        try {
            JsonNode root = mapper.readTree(responseBody);
            // Anthropic format: {"type":"error","error":{"type":"...","message":"..."}}
            JsonNode anthropicMsg = root.path("error").path("message");
            if (!anthropicMsg.isMissingNode() && !anthropicMsg.asText("").isBlank()) {
                return anthropicMsg.asText();
            }
            // OpenAI format: {"error":{"message":"...","type":"...","code":"..."}}
            JsonNode openaiMsg = root.path("error").path("message");
            if (!openaiMsg.isMissingNode() && !openaiMsg.asText("").isBlank()) {
                return openaiMsg.asText();
            }
        } catch (Exception ignored) {}
        // Fallback: truncated raw body
        return AiLoggers.truncate(responseBody, 300);
    }

    private List<GeneratedTestCase> parseGeneratedCases(String rawContent, int maxCount) {
        String normalized = stripMarkdownCodeFences(rawContent);
        JsonNode root;
        try {
            root = mapper.readTree(normalized);
        } catch (Exception firstParseError) {
            // Some models prepend prose before JSON. Try extracting the first JSON object.
            String extracted = extractFirstJsonObject(normalized);
            if (extracted == null) {
                AiLoggers.providerWarn(
                        "provider_parse_failure reason=no_json_object content=" +
                                AiLoggers.truncate(normalized, 1200)
                );
                return Collections.emptyList();
            }
            try {
                root = mapper.readTree(extracted);
            } catch (Exception ignored) {
                AiLoggers.providerWarn(
                        "provider_parse_failure reason=invalid_json content=" +
                                AiLoggers.truncate(extracted, 1200)
                );
                return Collections.emptyList();
            }
        }
        JsonNode draftsNode = root.path("drafts");
        if (!draftsNode.isArray()) {
            AiLoggers.providerWarn(
                    "provider_parse_failure reason=drafts_missing content=" +
                            AiLoggers.truncate(root.toString(), 1200)
            );
            return Collections.emptyList();
        }
        List<GeneratedTestCase> out = new ArrayList<>();
        for (JsonNode draft : draftsNode) {
            if (out.size() >= maxCount) break;
            String title = safeText(draft.path("title"), "Generated test case");
            String preconditions = safeText(draft.path("preconditions"), "");
            String stepsJson = draft.path("steps").isArray() ? draft.path("steps").toString() : "[]";
            String expectedSummary = safeText(draft.path("expectedSummary"), "");
            String priority = normalizePriority(safeText(draft.path("priority"), "P2"));
            List<String> tags = new ArrayList<>();
            JsonNode tagsNode = draft.path("tags");
            if (tagsNode.isArray()) {
                for (JsonNode t : tagsNode) {
                    String tag = t.asText("").trim();
                    if (!tag.isBlank()) tags.add(tag);
                    if (tags.size() >= 10) break;
                }
            }
            out.add(new GeneratedTestCase(title, preconditions, stepsJson, expectedSummary, priority, tags));
        }
        AiLoggers.providerInfo("provider_parse_success parsedDraftCount=" + out.size());
        return out;
    }

    private String buildGenerationPrompt(GenerateRequest request) {
        StringBuilder sb = new StringBuilder();
        sb.append("Generate software test cases from the following feature input.\n");
        sb.append("Return ONLY JSON. No markdown. No explanation.\n\n");
        sb.append("Required JSON schema:\n");
        sb.append("{\"drafts\":[{\"title\":\"string\",\"preconditions\":\"string\",\"steps\":[{\"stepNumber\":1,\"action\":\"string\",\"expectedResult\":\"string\"}],\"expectedSummary\":\"string\",\"priority\":\"P0|P1|P2|P3\",\"tags\":[\"string\"]}]}\n\n");
        sb.append("Constraints:\n");
        sb.append("- Generate exactly ").append(request.count()).append(" drafts.\n");
        sb.append("- Use test design techniques including boundary value analysis where applicable.\n");
        sb.append("- Keep each test case practical and execution-ready.\n");
        sb.append("- Include realistic preconditions and expected results.\n");
        sb.append("- Do not include empty titles.\n");
        sb.append("- Priority must be one of P0,P1,P2,P3.\n\n");
        sb.append("Coverage requirements:\n");
        sb.append("- Functional Happy Flow: ").append(request.includeHappyFlow()).append("\n");
        sb.append("- Functional Negative Flow: ").append(request.includeNegativeFlow()).append("\n");
        sb.append("- Multi Tab scenarios if required: ").append(request.includeMultiTab()).append("\n");
        sb.append("- Cross browser scenarios if required: ").append(request.includeCrossBrowser()).append("\n");
        sb.append("- Boundary value analysis focus: ").append(request.includeBoundary()).append("\n\n");
        sb.append("Generation style: ").append(request.style() != null ? request.style() : "strict").append("\n\n");
        sb.append("User story / feature details:\n").append(request.userStory()).append("\n\n");
        if (request.acceptanceCriteria() != null && !request.acceptanceCriteria().isBlank()) {
            sb.append("Acceptance criteria:\n").append(request.acceptanceCriteria()).append("\n\n");
        }
        if (request.customPrompt() != null && !request.customPrompt().isBlank()) {
            sb.append("Additional user instructions:\n").append(request.customPrompt()).append("\n");
        }
        return sb.toString();
    }

    private String stripMarkdownCodeFences(String content) {
        String trimmed = content.trim();
        if (trimmed.startsWith("```")) {
            int firstNewline = trimmed.indexOf('\n');
            int lastFence = trimmed.lastIndexOf("```");
            if (firstNewline > 0 && lastFence > firstNewline) {
                return trimmed.substring(firstNewline + 1, lastFence).trim();
            }
        }
        return trimmed;
    }

    private String extractFirstJsonObject(String text) {
        int start = text.indexOf('{');
        if (start < 0) return null;
        int depth = 0;
        boolean inString = false;
        boolean escape = false;
        for (int i = start; i < text.length(); i++) {
            char ch = text.charAt(i);
            if (escape) {
                escape = false;
                continue;
            }
            if (ch == '\\') {
                escape = true;
                continue;
            }
            if (ch == '"') {
                inString = !inString;
                continue;
            }
            if (inString) continue;
            if (ch == '{') depth++;
            if (ch == '}') {
                depth--;
                if (depth == 0) {
                    return text.substring(start, i + 1);
                }
            }
        }
        return null;
    }

    private String safeText(JsonNode node, String fallback) {
        if (node == null || node.isNull()) return fallback;
        String value = node.asText("").trim();
        if (value.isBlank()) return fallback;
        return value.length() > 500 ? value.substring(0, 500) : value;
    }

    private String normalizePriority(String raw) {
        return switch (raw.trim().toUpperCase()) {
            case "P0" -> "P0";
            case "P1" -> "P1";
            case "P3" -> "P3";
            default -> "P2";
        };
    }
}
