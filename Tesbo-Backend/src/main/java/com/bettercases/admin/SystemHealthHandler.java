package com.bettercases.admin;

import com.bettercases.Config;
import com.bettercases.Database;
import io.javalin.http.Context;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

public final class SystemHealthHandler {

    private static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();

    public static void check(Context ctx) {
        SuperAdminService.requirePlatformAdmin(ctx);

        Map<String, Object> services = new LinkedHashMap<>();
        boolean allUp = true;

        services.put("backend", Map.of("status", "up", "latency_ms", 0));

        // PostgreSQL
        Map<String, Object> dbStatus = probeDatabase();
        services.put("database", dbStatus);
        if (!"up".equals(dbStatus.get("status"))) allUp = false;

        // Automation Agent
        Map<String, Object> automationStatus = probeHttp("automation_agent",
                Config.AUTOMATION_AGENT_BASE_URL + "/health");
        services.put("automation_agent", automationStatus);
        if (!"up".equals(automationStatus.get("status"))) allUp = false;

        // Artifact Storage
        Map<String, Object> storageStatus = probeArtifactStorage();
        services.put("artifact_storage", storageStatus);
        if (!"up".equals(storageStatus.get("status"))) allUp = false;

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("status", allUp ? "healthy" : "degraded");
        result.put("timestamp", Instant.now().toString());
        result.put("services", services);

        ctx.json(result);
    }

    private static Map<String, Object> probeDatabase() {
        Map<String, Object> status = new LinkedHashMap<>();
        long start = System.currentTimeMillis();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("SELECT 1")) {
            ps.executeQuery();
            long latency = System.currentTimeMillis() - start;
            status.put("status", "up");
            status.put("latency_ms", latency);

            try (PreparedStatement v = c.prepareStatement(
                    "SELECT id FROM databasechangelog ORDER BY orderexecuted DESC LIMIT 1")) {
                ResultSet rs = v.executeQuery();
                if (rs.next()) {
                    status.put("latest_migration", rs.getString("id"));
                }
            } catch (Exception ignored) {}
        } catch (Exception e) {
            status.put("status", "down");
            status.put("error", e.getMessage());
            status.put("latency_ms", System.currentTimeMillis() - start);
        }
        return status;
    }

    private static Map<String, Object> probeHttp(String name, String url) {
        Map<String, Object> status = new LinkedHashMap<>();
        long start = System.currentTimeMillis();
        try {
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .timeout(Duration.ofSeconds(5))
                    .GET()
                    .build();
            HttpResponse<String> resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
            long latency = System.currentTimeMillis() - start;
            if (resp.statusCode() >= 200 && resp.statusCode() < 300) {
                status.put("status", "up");
            } else {
                status.put("status", "down");
                status.put("http_status", resp.statusCode());
            }
            status.put("latency_ms", latency);
            status.put("url", url);
        } catch (Exception e) {
            status.put("status", "down");
            status.put("error", e.getClass().getSimpleName() + ": " + e.getMessage());
            status.put("latency_ms", System.currentTimeMillis() - start);
            status.put("url", url);
        }
        return status;
    }

    private static Map<String, Object> probeArtifactStorage() {
        Map<String, Object> status = new LinkedHashMap<>();
        String provider = Config.TESBO_ARTIFACT_STORAGE_PROVIDER;
        status.put("provider", provider);

        if ("spaces".equals(provider) || "s3".equals(provider)) {
            boolean configured = !Config.TESBO_SPACES_ENDPOINT.isEmpty()
                    && !Config.TESBO_SPACES_BUCKET.isEmpty()
                    && !Config.TESBO_SPACES_ACCESS_KEY.isEmpty();
            status.put("status", configured ? "up" : "misconfigured");
            if (!configured) {
                status.put("error", "Missing storage configuration");
            }
        } else {
            java.io.File uploadDir = new java.io.File(Config.UPLOAD_DIR);
            status.put("status", uploadDir.exists() && uploadDir.canWrite() ? "up" : "down");
            if (!uploadDir.exists()) {
                status.put("error", "Upload directory does not exist: " + Config.UPLOAD_DIR);
            }
        }
        return status;
    }

    private SystemHealthHandler() {}
}
