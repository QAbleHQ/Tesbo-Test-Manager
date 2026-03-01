package com.bettercases.cycle;

import com.bettercases.Database;
import com.bettercases.rbac.RbacService;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class CycleRunScheduleService {
    public static List<Map<String, Object>> list(UUID projectId, UUID userId) {
        RbacService.requireProjectRole(userId, projectId);
        String sql = """
                SELECT id, project_id, cycle_id, name, enabled, schedule_type, run_at, interval_minutes,
                       timezone, next_run_at, last_run_at, last_status, last_error, created_by,
                       created_at, updated_at
                FROM cycle_run_schedules
                WHERE project_id = ?
                ORDER BY created_at DESC
                """;
        List<Map<String, Object>> out = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) out.add(mapRow(rs));
            return out;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static Map<String, Object> create(UUID projectId, UUID userId, UUID cycleId, String name, String scheduleType,
                                             String runAtIso, Integer intervalMinutes, String timezone, Boolean enabled) {
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).orElseThrow().canManagePlansCycles()) {
            throw new io.javalin.http.ForbiddenResponse("Cannot create run schedule");
        }
        UUID cycleProjectId = CycleService.getProjectIdForCycle(cycleId);
        if (!projectId.equals(cycleProjectId)) {
            throw new io.javalin.http.BadRequestResponse("Cycle does not belong to project");
        }
        validateRunAutomatedOnly(cycleId);
        String normalizedType = normalizeType(scheduleType);
        Instant runAt = parseIso(runAtIso);
        Integer normalizedInterval = normalizeIntervalMinutes(intervalMinutes);
        Instant nextRunAt = computeNextRunAt(normalizedType, runAt, normalizedInterval, Instant.now());
        boolean isEnabled = enabled == null || enabled;
        String sql = """
                INSERT INTO cycle_run_schedules (
                  project_id, cycle_id, name, enabled, schedule_type, run_at, interval_minutes,
                  timezone, next_run_at, created_by
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                RETURNING id, project_id, cycle_id, name, enabled, schedule_type, run_at, interval_minutes,
                          timezone, next_run_at, last_run_at, last_status, last_error, created_by,
                          created_at, updated_at
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ps.setObject(2, cycleId);
            ps.setString(3, safeName(name));
            ps.setBoolean(4, isEnabled);
            ps.setString(5, normalizedType);
            ps.setTimestamp(6, runAt != null ? Timestamp.from(runAt) : null);
            if (normalizedInterval == null) ps.setObject(7, null);
            else ps.setInt(7, normalizedInterval);
            ps.setString(8, timezone == null || timezone.isBlank() ? "UTC" : timezone.trim());
            ps.setTimestamp(9, (isEnabled && nextRunAt != null) ? Timestamp.from(nextRunAt) : null);
            ps.setObject(10, userId);
            ResultSet rs = ps.executeQuery();
            rs.next();
            return mapRow(rs);
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static void update(UUID scheduleId, UUID userId, String name, Boolean enabled, String scheduleType,
                              String runAtIso, Integer intervalMinutes, String timezone, String cycleIdRaw) {
        UUID projectId = getProjectId(scheduleId);
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).orElseThrow().canManagePlansCycles()) {
            throw new io.javalin.http.ForbiddenResponse("Cannot update run schedule");
        }
        Map<String, Object> existing = getInternal(scheduleId);
        UUID cycleId = cycleIdRaw != null && !cycleIdRaw.isBlank()
                ? UUID.fromString(cycleIdRaw)
                : UUID.fromString(String.valueOf(existing.get("cycleId")));
        if (!projectId.equals(CycleService.getProjectIdForCycle(cycleId))) {
            throw new io.javalin.http.BadRequestResponse("Cycle does not belong to project");
        }
        validateRunAutomatedOnly(cycleId);
        String normalizedType = scheduleType != null ? normalizeType(scheduleType) : String.valueOf(existing.get("scheduleType"));
        Instant runAt = runAtIso != null ? parseIso(runAtIso) : parseIsoOrNull(existing.get("runAt"));
        Integer normalizedInterval = intervalMinutes != null
                ? normalizeIntervalMinutes(intervalMinutes)
                : (existing.get("intervalMinutes") instanceof Number n ? n.intValue() : null);
        boolean isEnabled = enabled != null ? enabled : Boolean.TRUE.equals(existing.get("enabled"));
        Instant nextRunAt = computeNextRunAt(normalizedType, runAt, normalizedInterval, Instant.now());
        String sql = """
                UPDATE cycle_run_schedules SET
                  cycle_id = ?,
                  name = ?,
                  enabled = ?,
                  schedule_type = ?,
                  run_at = ?,
                  interval_minutes = ?,
                  timezone = ?,
                  next_run_at = ?,
                  updated_at = now()
                WHERE id = ?
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, cycleId);
            ps.setString(2, name != null ? safeName(name) : String.valueOf(existing.get("name")));
            ps.setBoolean(3, isEnabled);
            ps.setString(4, normalizedType);
            ps.setTimestamp(5, runAt != null ? Timestamp.from(runAt) : null);
            if (normalizedInterval == null) ps.setObject(6, null);
            else ps.setInt(6, normalizedInterval);
            ps.setString(7, timezone != null ? timezone : String.valueOf(existing.get("timezone")));
            ps.setTimestamp(8, (isEnabled && nextRunAt != null) ? Timestamp.from(nextRunAt) : null);
            ps.setObject(9, scheduleId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static void delete(UUID scheduleId, UUID userId) {
        UUID projectId = getProjectId(scheduleId);
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).orElseThrow().canManagePlansCycles()) {
            throw new io.javalin.http.ForbiddenResponse("Cannot delete run schedule");
        }
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("DELETE FROM cycle_run_schedules WHERE id = ?")) {
            ps.setObject(1, scheduleId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    static List<Map<String, Object>> claimDueSchedules(int limit) {
        String sql = """
                WITH due AS (
                  SELECT id
                  FROM cycle_run_schedules
                  WHERE enabled = true
                    AND is_running = false
                    AND next_run_at IS NOT NULL
                    AND next_run_at <= now()
                  ORDER BY next_run_at ASC
                  FOR UPDATE SKIP LOCKED
                  LIMIT ?
                )
                UPDATE cycle_run_schedules s
                SET is_running = true, updated_at = now()
                FROM due
                WHERE s.id = due.id
                RETURNING s.id, s.project_id, s.cycle_id, s.name, s.enabled, s.schedule_type, s.run_at,
                          s.interval_minutes, s.timezone, s.next_run_at, s.last_run_at, s.last_status,
                          s.last_error, s.created_by, s.created_at, s.updated_at
                """;
        List<Map<String, Object>> out = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setInt(1, Math.max(1, limit));
            ResultSet rs = ps.executeQuery();
            while (rs.next()) out.add(mapRow(rs));
            return out;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    static void finishRun(UUID scheduleId, String status, String errorMessage) {
        Map<String, Object> row = getInternal(scheduleId);
        String scheduleType = String.valueOf(row.get("scheduleType"));
        Instant baseNext = parseIsoOrNull(row.get("nextRunAt"));
        Integer intervalMinutes = row.get("intervalMinutes") instanceof Number n ? n.intValue() : null;
        boolean enabled = Boolean.TRUE.equals(row.get("enabled"));
        Instant now = Instant.now();
        Instant nextRunAt = null;
        boolean finalEnabled = enabled;
        if (enabled) {
            if ("recurring".equals(scheduleType)) {
                Instant base = baseNext != null ? baseNext : now;
                nextRunAt = base.plusSeconds((long) intervalMinutes * 60);
            } else {
                finalEnabled = false;
            }
        }
        String sql = """
                UPDATE cycle_run_schedules SET
                  is_running = false,
                  enabled = ?,
                  next_run_at = ?,
                  last_run_at = now(),
                  last_status = ?,
                  last_error = ?,
                  updated_at = now()
                WHERE id = ?
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setBoolean(1, finalEnabled);
            ps.setTimestamp(2, nextRunAt != null ? Timestamp.from(nextRunAt) : null);
            ps.setString(3, status);
            ps.setString(4, errorMessage);
            ps.setObject(5, scheduleId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static void validateRunAutomatedOnly(UUID cycleId) {
        List<String> violations = CycleAutomationRunService.validateAutomatedOnly(cycleId);
        if (!violations.isEmpty()) {
            throw new io.javalin.http.BadRequestResponse(
                    "Scheduled run requires automated-only test cases. Missing scripts: " + String.join(", ", violations)
            );
        }
    }

    private static String normalizeType(String value) {
        String type = value == null ? "" : value.trim().toLowerCase();
        if (!"one_time".equals(type) && !"recurring".equals(type)) {
            throw new io.javalin.http.BadRequestResponse("scheduleType must be one_time or recurring");
        }
        return type;
    }

    private static Integer normalizeIntervalMinutes(Integer value) {
        if (value == null) return null;
        if (value <= 0) {
            throw new io.javalin.http.BadRequestResponse("intervalMinutes must be > 0");
        }
        return value;
    }

    private static Instant computeNextRunAt(String scheduleType, Instant runAt, Integer intervalMinutes, Instant now) {
        if ("one_time".equals(scheduleType)) {
            if (runAt == null) throw new io.javalin.http.BadRequestResponse("runAt is required for one_time schedule");
            return runAt;
        }
        if (intervalMinutes == null || intervalMinutes <= 0) {
            throw new io.javalin.http.BadRequestResponse("intervalMinutes is required for recurring schedule");
        }
        return now.plusSeconds((long) intervalMinutes * 60);
    }

    private static Map<String, Object> getInternal(UUID scheduleId) {
        String sql = """
                SELECT id, project_id, cycle_id, name, enabled, schedule_type, run_at, interval_minutes,
                       timezone, next_run_at, last_run_at, last_status, last_error, created_by,
                       created_at, updated_at
                FROM cycle_run_schedules
                WHERE id = ?
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, scheduleId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) throw new io.javalin.http.NotFoundResponse();
            return mapRow(rs);
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static UUID getProjectId(UUID scheduleId) {
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("SELECT project_id FROM cycle_run_schedules WHERE id = ?")) {
            ps.setObject(1, scheduleId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) return (UUID) rs.getObject("project_id");
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        throw new io.javalin.http.NotFoundResponse();
    }

    private static String safeName(String name) {
        String n = name == null ? "" : name.trim();
        if (n.isBlank()) throw new io.javalin.http.BadRequestResponse("name is required");
        return n;
    }

    private static Instant parseIso(String value) {
        if (value == null || value.isBlank()) return null;
        try {
            return Instant.parse(value);
        } catch (Exception e) {
            throw new io.javalin.http.BadRequestResponse("Invalid ISO date: " + value);
        }
    }

    private static Instant parseIsoOrNull(Object value) {
        if (value == null) return null;
        try {
            return Instant.parse(String.valueOf(value));
        } catch (Exception ignored) {
            return null;
        }
    }

    private static Map<String, Object> mapRow(ResultSet rs) throws SQLException {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", rs.getObject("id").toString());
        m.put("projectId", rs.getObject("project_id").toString());
        m.put("cycleId", rs.getObject("cycle_id").toString());
        m.put("name", rs.getString("name"));
        m.put("enabled", rs.getBoolean("enabled"));
        m.put("scheduleType", rs.getString("schedule_type"));
        Timestamp runAt = rs.getTimestamp("run_at");
        m.put("runAt", runAt != null ? runAt.toInstant().toString() : null);
        Object intervalMinutes = rs.getObject("interval_minutes");
        m.put("intervalMinutes", intervalMinutes != null ? ((Number) intervalMinutes).intValue() : null);
        m.put("timezone", rs.getString("timezone"));
        Timestamp nextRunAt = rs.getTimestamp("next_run_at");
        m.put("nextRunAt", nextRunAt != null ? nextRunAt.toInstant().toString() : null);
        Timestamp lastRunAt = rs.getTimestamp("last_run_at");
        m.put("lastRunAt", lastRunAt != null ? lastRunAt.toInstant().toString() : null);
        m.put("lastStatus", rs.getString("last_status"));
        m.put("lastError", rs.getString("last_error"));
        Object createdBy = rs.getObject("created_by");
        m.put("createdBy", createdBy != null ? createdBy.toString() : null);
        m.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
        m.put("updatedAt", rs.getTimestamp("updated_at").toInstant().toString());
        return m;
    }

    private CycleRunScheduleService() {}
}
