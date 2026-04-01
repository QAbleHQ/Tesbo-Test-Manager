package com.bettercases.ai;

public final class AiKeySanitizer {
    private AiKeySanitizer() {}

    public static String sanitize(String raw) {
        if (raw == null) return "";
        String key = raw.trim();
        if (key.isEmpty()) return "";

        if ((key.startsWith("\"") && key.endsWith("\"")) || (key.startsWith("'") && key.endsWith("'"))) {
            key = key.substring(1, key.length() - 1).trim();
        }

        if (key.toLowerCase().startsWith("bearer")) {
            int split = key.indexOf(' ');
            if (split < 0) {
                key = "";
            } else {
                key = key.substring(split + 1).trim();
            }
        }

        // Provider keys should not contain whitespace; strip hidden newlines/tabs from copy-paste.
        key = key.replaceAll("\\s+", "");

        return key;
    }

    public static boolean looksLikeAnthropicKey(String key) {
        String normalized = sanitize(key).toLowerCase();
        return normalized.startsWith("sk-ant");
    }

    public static boolean looksLikeOpenAiKey(String key) {
        String normalized = sanitize(key).toLowerCase();
        return normalized.startsWith("sk-") && !normalized.startsWith("sk-ant");
    }
}
