package com.bettercases;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

public final class Config {
    private static final Map<String, String> DOT_ENV = loadDotEnv();

    private static final String CORS_ALLOWED_ORIGINS_DEFAULT =
            "http://localhost:3000,http://localhost:3001,"
                    + "http://127.0.0.1:3000,http://127.0.0.1:3001,"
                    + "https://frontdoor.tesbo.io,https://automate.tesbo.io,https://exe.tesbo.io,https://backdoor.tesbo.io";

    public static final int SERVER_PORT = Integer.parseInt(getEnv("PORT", "7000"));
    public static final String DB_URL = getEnv("DATABASE_URL", "jdbc:postgresql://localhost:5432/bettercases");
    public static final String DB_USER = getEnv("DATABASE_USER", "postgres");
    public static final String DB_PASSWORD = getEnv("DATABASE_PASSWORD", "postgres");
    public static final String POSTMARK_API_TOKEN = getEnv("POSTMARK_API_TOKEN", "");
    public static final String POSTMARK_FROM_EMAIL = getEnv("POSTMARK_FROM_EMAIL", "noreply@example.com");
    public static final int OTP_EXPIRY_MINUTES = Integer.parseInt(getEnv("OTP_EXPIRY_MINUTES", "10"));
    public static final int OTP_MAX_ATTEMPTS = Integer.parseInt(getEnv("OTP_MAX_ATTEMPTS", "5"));
    public static final int OTP_RATE_LIMIT_WINDOW_MINUTES = Integer.parseInt(getEnv("OTP_RATE_LIMIT_WINDOW_MINUTES", "15"));
    public static final int SESSION_DAYS = Integer.parseInt(getEnv("SESSION_DAYS", "30"));
    public static final String SESSION_COOKIE_NAME = "bettercases_session";
    public static final Set<String> CORS_ALLOWED_ORIGINS = parseCsv(corsAllowedOriginsEnv());

    // Jira OAuth 2.0 (3LO) configuration
    public static final String JIRA_CLIENT_ID = getEnv("JIRA_CLIENT_ID", "");
    public static final String JIRA_CLIENT_SECRET = getEnv("JIRA_CLIENT_SECRET", "");
    public static final String JIRA_REDIRECT_URI = getEnv("JIRA_REDIRECT_URI", "http://localhost:3000/jira/callback");
    public static final String FRONTEND_URL = getEnv("FRONTEND_URL", "http://localhost:3000");

    // File upload configuration
    public static final String UPLOAD_DIR = getEnv("UPLOAD_DIR", "./uploads");
    public static final long MAX_UPLOAD_SIZE = Long.parseLong(getEnv("MAX_UPLOAD_SIZE", "10485760")); // 10MB

    // Tesbo artifact storage configuration
    public static final String TESBO_ARTIFACT_STORAGE_PROVIDER = getEnv("TESBO_ARTIFACT_STORAGE_PROVIDER", "local").trim().toLowerCase();
    public static final String TESBO_SPACES_ENDPOINT = getEnv("TESBO_SPACES_ENDPOINT", "").trim();
    public static final String TESBO_SPACES_REGION = getEnv("TESBO_SPACES_REGION", "us-east-1").trim();
    public static final String TESBO_SPACES_BUCKET = getEnv("TESBO_SPACES_BUCKET", "").trim();
    public static final String TESBO_SPACES_ACCESS_KEY = getEnv("TESBO_SPACES_ACCESS_KEY", "").trim();
    public static final String TESBO_SPACES_SECRET_KEY = getEnv("TESBO_SPACES_SECRET_KEY", "").trim();
    public static final int TESBO_SIGNED_URL_TTL_SECONDS = Integer.parseInt(getEnv("TESBO_SIGNED_URL_TTL_SECONDS", "600"));
    public static final String AUTOMATION_AGENT_BASE_URL = getEnv("AUTOMATION_AGENT_BASE_URL", "http://localhost:7400");
    public static final String AUTOMATION_AGENT_SHARED_TOKEN = getEnv("AUTOMATION_AGENT_SHARED_TOKEN", "");
    public static final int AUTOMATION_STEP_TIMEOUT_MS = Integer.parseInt(getEnv("AUTOMATION_STEP_TIMEOUT_MS", "10000"));
    public static final int AUTOMATION_AUTONOMOUS_MAX_TURNS = Integer.parseInt(getEnv("AUTOMATION_AUTONOMOUS_MAX_TURNS", "15"));
    public static final int AUTOMATION_AUTONOMOUS_MAX_STEPS = Integer.parseInt(getEnv("AUTOMATION_AUTONOMOUS_MAX_STEPS", "50"));
    public static final boolean AUTOMATION_AUTONOMOUS_VERBOSE_EVENTS = Boolean.parseBoolean(
            getEnv("AUTOMATION_AUTONOMOUS_VERBOSE_EVENTS", "false")
    );
    public static final int AUTOMATION_QUEUE_MAX_RETRIES = Integer.parseInt(getEnv("AUTOMATION_QUEUE_MAX_RETRIES", "2"));
    /** Hard ceiling for per-project concurrent jobs (settings cannot exceed this). */
    public static final int AUTOMATION_QUEUE_MAX_CONCURRENT_JOBS_CEILING =
            Integer.parseInt(getEnv("AUTOMATION_QUEUE_MAX_CONCURRENT_JOBS_CEILING", "200"));

    public static final String EXECUTION_SERVICE_BASE_URL = getEnv("EXECUTION_SERVICE_BASE_URL", "http://localhost:7420");
    public static final String EXECUTION_SERVICE_API_KEY = getEnv("EXECUTION_SERVICE_API_KEY", "");
    /** Webhook URL the Execution Service will POST state changes to (should point to this backend) */
    public static final String EXECUTION_SERVICE_WEBHOOK_URL = getEnv("EXECUTION_SERVICE_WEBHOOK_URL", "");
    public static final String EXECUTION_SERVICE_WEBHOOK_SECRET = getEnv("EXECUTION_SERVICE_WEBHOOK_SECRET", "");

    private static Map<String, String> loadDotEnv() {
        Map<String, String> map = new HashMap<>();
        for (Path dir : new Path[]{
                Path.of(System.getProperty("user.dir", "")),
                Path.of(System.getProperty("user.dir", "")).resolve("backend")
        }) {
            Path env = dir.resolve(".env");
            if (!Files.isRegularFile(env)) continue;
            try {
                for (String line : Files.readAllLines(env)) {
                    line = line.trim();
                    if (line.isEmpty() || line.startsWith("#")) continue;
                    int eq = line.indexOf('=');
                    if (eq <= 0) continue;
                    String key = line.substring(0, eq).trim();
                    String value = line.substring(eq + 1).trim();
                    if (value.startsWith("\"") && value.endsWith("\"")) value = value.substring(1, value.length() - 1);
                    map.put(key, value);
                }
            } catch (IOException ignored) { }
            break;
        }
        return map;
    }

    private static String getEnv(String key, String defaultValue) {
        return Optional.ofNullable(DOT_ENV.get(key))
                .or(() -> Optional.ofNullable(System.getenv(key)))
                .orElse(defaultValue);
    }

    private static String corsAllowedOriginsEnv() {
        String v = getEnv("CORS_ALLOWED_ORIGINS", CORS_ALLOWED_ORIGINS_DEFAULT);
        return v.isBlank() ? CORS_ALLOWED_ORIGINS_DEFAULT : v;
    }

    private static Set<String> parseCsv(String csv) {
        Set<String> values = new LinkedHashSet<>();
        Arrays.stream(csv.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .map(Config::normalizeCorsOrigin)
                .filter(s -> !s.isEmpty())
                .forEach(values::add);
        return values;
    }

    /**
     * Normalizes a browser {@code Origin} or an entry from {@code CORS_ALLOWED_ORIGINS} so they match
     * even when secrets contain a UTF-8 BOM, stray whitespace, or a trailing slash.
     */
    public static String normalizeCorsOrigin(String raw) {
        if (raw == null) {
            return "";
        }
        String o = raw.trim();
        if (!o.isEmpty() && o.charAt(0) == '\uFEFF') {
            o = o.substring(1).trim();
        }
        while (o.endsWith("/")) {
            o = o.substring(0, o.length() - 1).trim();
        }
        return o;
    }

    private Config() {}
}
