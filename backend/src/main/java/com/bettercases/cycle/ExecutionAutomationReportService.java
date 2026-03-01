package com.bettercases.cycle;

import com.bettercases.Database;
import com.bettercases.rbac.RbacService;
import com.bettercases.tesbo.TesboArtifactStorageService;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class ExecutionAutomationReportService {
    private static final ObjectMapper mapper = new ObjectMapper();

    public static void upsert(UUID cycleId, UUID executionId, String status, String startedAtIso, String endedAtIso,
                              List<Map<String, Object>> logs, String videoPath, String screenshotPath, String errorMessage) {
        String sql = """
                INSERT INTO execution_automation_reports (
                  cycle_id, execution_id, status, started_at, ended_at, logs_json, video_path, screenshot_path, error_message
                ) VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)
                ON CONFLICT (execution_id) DO UPDATE SET
                  status = EXCLUDED.status,
                  started_at = EXCLUDED.started_at,
                  ended_at = EXCLUDED.ended_at,
                  logs_json = EXCLUDED.logs_json,
                  video_path = EXCLUDED.video_path,
                  screenshot_path = EXCLUDED.screenshot_path,
                  error_message = EXCLUDED.error_message,
                  updated_at = now()
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            String videoRef = persistArtifactIfNeeded(
                    cycleId,
                    executionId,
                    videoPath,
                    "video",
                    detectContentType(videoPath, "video/webm")
            );
            String screenshotRef = persistArtifactIfNeeded(
                    cycleId,
                    executionId,
                    screenshotPath,
                    "screenshot",
                    detectContentType(screenshotPath, "image/png")
            );
            List<Map<String, Object>> normalizedLogs = normalizeLogsWithArtifacts(cycleId, executionId, logs);
            ps.setObject(1, cycleId);
            ps.setObject(2, executionId);
            ps.setString(3, status);
            ps.setTimestamp(4, startedAtIso != null ? Timestamp.from(java.time.Instant.parse(startedAtIso)) : new Timestamp(System.currentTimeMillis()));
            ps.setTimestamp(5, endedAtIso != null ? Timestamp.from(java.time.Instant.parse(endedAtIso)) : new Timestamp(System.currentTimeMillis()));
            ps.setString(6, mapper.writeValueAsString(normalizedLogs));
            ps.setString(7, videoRef);
            ps.setString(8, screenshotRef);
            ps.setString(9, errorMessage);
            ps.executeUpdate();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static Map<String, Object> get(UUID cycleId, UUID executionId, UUID userId) {
        UUID projectId = CycleService.getProjectIdForCycle(cycleId);
        RbacService.requireProjectRole(userId, projectId);
        String sql = """
                SELECT id, cycle_id, execution_id, status, started_at, ended_at, logs_json, video_path, screenshot_path, error_message,
                       created_at, updated_at
                FROM execution_automation_reports
                WHERE cycle_id = ? AND execution_id = ?
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, cycleId);
            ps.setObject(2, executionId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) {
                return Map.of(
                        "executionId", executionId.toString(),
                        "status", "not_available",
                        "logs", List.of(),
                        "videoAvailable", false
                );
            }
            Map<String, Object> out = new HashMap<>();
            out.put("id", rs.getObject("id").toString());
            out.put("cycleId", rs.getObject("cycle_id").toString());
            out.put("executionId", rs.getObject("execution_id").toString());
            out.put("status", rs.getString("status"));
            out.put("startedAt", rs.getTimestamp("started_at").toInstant().toString());
            out.put("endedAt", rs.getTimestamp("ended_at").toInstant().toString());
            String logsRaw = rs.getString("logs_json");
            List<Map<String, Object>> logs = logsRaw == null || logsRaw.isBlank()
                    ? List.of()
                    : mapper.readValue(logsRaw, new TypeReference<>() {});
            out.put("logs", logs);
            String videoRef = rs.getString("video_path");
            out.put("videoAvailable", videoRef != null && !videoRef.isBlank());
            out.put("videoUrl", resolveArtifactUrl(videoRef));
            String screenshotRef = rs.getString("screenshot_path");
            out.put("screenshotPath", screenshotRef);
            out.put("screenshotUrl", resolveArtifactUrl(screenshotRef));
            out.put("errorMessage", rs.getString("error_message"));
            out.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
            out.put("updatedAt", rs.getTimestamp("updated_at").toInstant().toString());
            return out;
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static TesboArtifactStorageService.ArtifactReadResult getVideoArtifact(UUID cycleId, UUID executionId, UUID userId) {
        UUID projectId = CycleService.getProjectIdForCycle(cycleId);
        RbacService.requireProjectRole(userId, projectId);
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(
                     "SELECT video_path FROM execution_automation_reports WHERE cycle_id = ? AND execution_id = ?")) {
            ps.setObject(1, cycleId);
            ps.setObject(2, executionId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) throw new io.javalin.http.NotFoundResponse("Automation video not found");
            String ref = rs.getString("video_path");
            if (ref == null || ref.isBlank()) throw new io.javalin.http.NotFoundResponse("Automation video not found");
            Path maybeLocal = Path.of(ref);
            if (Files.exists(maybeLocal)) {
                return new TesboArtifactStorageService.ArtifactReadResult(false, null, Files.newInputStream(maybeLocal), detectContentType(ref, "video/webm"));
            }
            TesboArtifactStorageService.ArtifactReadResult result =
                    TesboArtifactStorageService.read(ref, null, detectContentType(ref, "video/webm"));
            if (result == null) throw new io.javalin.http.NotFoundResponse("Automation video not found");
            return result;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }

    private static String persistArtifactIfNeeded(UUID cycleId, UUID executionId, String rawPathOrKey, String kind, String contentType) {
        if (rawPathOrKey == null || rawPathOrKey.isBlank()) return null;
        Path path = Path.of(rawPathOrKey);
        if (!Files.exists(path)) {
            return rawPathOrKey;
        }
        try {
            byte[] bytes = Files.readAllBytes(path);
            String ext = TesboArtifactStorageService.extensionFor(kind, contentType);
            String storageKey = "automation-runs/" + cycleId + "/" + executionId + "/" + kind + "." + ext;
            TesboArtifactStorageService.ArtifactLocation location =
                    TesboArtifactStorageService.store(storageKey, bytes, contentType);
            return location.storageKey();
        } catch (Exception e) {
            return rawPathOrKey;
        }
    }

    private static String resolveArtifactUrl(String ref) {
        if (ref == null || ref.isBlank()) return null;
        Path path = Path.of(ref);
        if (Files.exists(path)) return null;
        return TesboArtifactStorageService.resolveDirectUrlIfAvailable(ref);
    }

    private static String detectContentType(String pathOrKey, String fallback) {
        if (pathOrKey == null) return fallback;
        String lower = pathOrKey.toLowerCase();
        if (lower.endsWith(".mp4")) return "video/mp4";
        if (lower.endsWith(".webm")) return "video/webm";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        return fallback;
    }

    private static List<Map<String, Object>> normalizeLogsWithArtifacts(UUID cycleId, UUID executionId, List<Map<String, Object>> logs) {
        if (logs == null || logs.isEmpty()) return List.of();
        java.util.ArrayList<Map<String, Object>> out = new java.util.ArrayList<>();
        int index = 0;
        for (Map<String, Object> log : logs) {
            index++;
            Map<String, Object> copy = new HashMap<>();
            if (log != null) copy.putAll(log);
            String screenshotRef = copy.get("screenshotPath") instanceof String s ? s : null;
            if (screenshotRef != null && !screenshotRef.isBlank()) {
                String persisted = persistArtifactIfNeeded(
                        cycleId,
                        executionId,
                        screenshotRef,
                        "step-screenshot-" + index,
                        detectContentType(screenshotRef, "image/png")
                );
                copy.put("screenshotPath", persisted);
                copy.put("screenshotUrl", resolveArtifactUrl(persisted));
            }
            out.add(copy);
        }
        return out;
    }

    private ExecutionAutomationReportService() {}
}
