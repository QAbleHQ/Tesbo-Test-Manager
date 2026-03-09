package com.bettercases.automation;

import com.bettercases.Config;
import com.bettercases.Database;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.Map;
import java.util.UUID;

/**
 * Resolves Browserbase API key and project ID for a given project.
 * <ul>
 *   <li><b>Default</b>: Uses platform env vars (BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID)</li>
 *   <li><b>Custom</b>: Uses credentials stored in project settings (automation.browserbaseApiKey, automation.browserbaseProjectId)</li>
 * </ul>
 */
public final class BrowserbaseCredentialsService {
    private static final ObjectMapper mapper = new ObjectMapper();

    public record Credentials(String apiKey, String projectId) {}

    public static Credentials resolve(UUID projectId) {
        Map<String, Object> settings = readProjectSettings(projectId);
        @SuppressWarnings("unchecked")
        Map<String, Object> automation = settings != null ? (Map<String, Object>) settings.get("automation") : null;
        if (automation == null) {
            return platformCredentials();
        }
        String agent = String.valueOf(automation.getOrDefault("browserAgent", "default")).trim().toLowerCase();
        if ("custom".equals(agent)) {
            String apiKey = String.valueOf(automation.getOrDefault("browserbaseApiKey", "")).trim();
            String projectIdStr = String.valueOf(automation.getOrDefault("browserbaseProjectId", "")).trim();
            if (!apiKey.isEmpty() && !projectIdStr.isEmpty()) {
                return new Credentials(apiKey, projectIdStr);
            }
        }
        return platformCredentials();
    }

    private static Credentials platformCredentials() {
        String apiKey = Config.BROWSERBASE_API_KEY;
        String projectId = Config.BROWSERBASE_PROJECT_ID;
        return new Credentials(apiKey != null ? apiKey : "", projectId != null ? projectId : "");
    }

    private static Map<String, Object> readProjectSettings(UUID projectId) {
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("SELECT settings FROM projects WHERE id = ?")) {
            ps.setObject(1, projectId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) return Map.of();
            String json = rs.getString("settings");
            if (json == null || json.isBlank()) return Map.of();
            return mapper.readValue(json, new TypeReference<>() {});
        } catch (Exception e) {
            return Map.of();
        }
    }
}
