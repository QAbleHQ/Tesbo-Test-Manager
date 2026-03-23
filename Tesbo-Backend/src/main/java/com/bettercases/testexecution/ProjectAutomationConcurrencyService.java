package com.bettercases.testexecution;

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
 * SaaS-style cap: max concurrent automation jobs (in Redis or running) per project.
 * Configured via project {@code settings.automation.maxConcurrentJobs}, bounded by env ceiling.
 */
public final class ProjectAutomationConcurrencyService {
    private static final ObjectMapper mapper = new ObjectMapper();

    public static int effectiveConcurrentJobLimit(UUID projectId) {
        int fromSettings = readMaxConcurrentFromSettings(projectId);
        if (fromSettings <= 0) {
            fromSettings = Config.AUTOMATION_QUEUE_DEFAULT_CONCURRENT_JOBS_PER_PROJECT;
        }
        return Math.max(1, Math.min(Config.AUTOMATION_QUEUE_MAX_CONCURRENT_JOBS_CEILING, fromSettings));
    }

    private static int readMaxConcurrentFromSettings(UUID projectId) {
        String sql = "SELECT settings FROM projects WHERE id = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) {
                return 0;
            }
            String raw = rs.getString("settings");
            if (raw == null || raw.isBlank()) {
                return 0;
            }
            Map<String, Object> settings = mapper.readValue(raw, new TypeReference<>() {});
            Object automationObject = settings.get("automation");
            if (!(automationObject instanceof Map<?, ?> automationMap)) {
                return 0;
            }
            Object v = automationMap.get("maxConcurrentJobs");
            if (v instanceof Number n) {
                return n.intValue();
            }
            if (v instanceof String s && !s.isBlank()) {
                try {
                    return Integer.parseInt(s.trim());
                } catch (NumberFormatException ignored) {
                    return 0;
                }
            }
            return 0;
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private ProjectAutomationConcurrencyService() {}
}
