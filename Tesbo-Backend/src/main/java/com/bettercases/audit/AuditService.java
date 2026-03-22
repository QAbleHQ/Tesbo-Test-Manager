package com.bettercases.audit;

import com.bettercases.Database;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.*;

public final class AuditService {

    public static void log(UUID actorId, String action, String entityType, String entityId,
                           String diffJson, String ipAddress, String userAgent) {
        log(actorId, null, action, entityType, entityId, null, diffJson, ipAddress, userAgent);
    }

    public static void log(String action, String entityType, String entityId, String diffJson, String ipAddress, String userAgent) {
        log(null, null, action, entityType, entityId, null, diffJson, ipAddress, userAgent);
    }

    public static void log(UUID actorId, UUID projectId, String action, String entityType,
                           String entityId, String entityName, String diffJson,
                           String ipAddress, String userAgent) {
        String sql = "INSERT INTO audit_logs (actor_id, project_id, action, entity_type, entity_id, entity_name, diff, ip_address, user_agent) " +
                     "VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, actorId);
            ps.setObject(2, projectId);
            ps.setString(3, action);
            ps.setString(4, entityType);
            ps.setString(5, entityId);
            ps.setString(6, entityName);
            ps.setString(7, diffJson != null ? diffJson : "{}");
            ps.setString(8, ipAddress);
            ps.setString(9, userAgent);
            ps.executeUpdate();
        } catch (Exception e) {
            System.err.println("Audit log failed: " + e.getMessage());
        }
    }

    public static void logActivity(UUID actorId, UUID projectId, String action,
                                   String entityType, String entityId, String entityName) {
        log(actorId, projectId, action, entityType, entityId, entityName, "{}", null, null);
    }

    public static List<Map<String, Object>> listByProject(UUID projectId, int limit, int offset, String entityTypeFilter) {
        StringBuilder sql = new StringBuilder(
            "SELECT al.id, al.actor_id, al.action, al.entity_type, al.entity_id, al.entity_name, " +
            "al.diff, al.created_at, u.email AS actor_email, u.name AS actor_name " +
            "FROM audit_logs al LEFT JOIN users u ON u.id = al.actor_id " +
            "WHERE al.project_id = ?"
        );
        List<Object> params = new ArrayList<>();
        params.add(projectId);

        if (entityTypeFilter != null && !entityTypeFilter.isBlank()) {
            sql.append(" AND al.entity_type = ?");
            params.add(entityTypeFilter);
        }

        sql.append(" ORDER BY al.created_at DESC LIMIT ? OFFSET ?");
        params.add(limit);
        params.add(offset);

        List<Map<String, Object>> rows = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql.toString())) {
            for (int i = 0; i < params.size(); i++) {
                ps.setObject(i + 1, params.get(i));
            }
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("id", rs.getObject("id").toString());
                Object actorId = rs.getObject("actor_id");
                row.put("actorId", actorId != null ? actorId.toString() : null);
                row.put("actorEmail", rs.getString("actor_email"));
                row.put("actorName", rs.getString("actor_name"));
                row.put("action", rs.getString("action"));
                row.put("entityType", rs.getString("entity_type"));
                row.put("entityId", rs.getString("entity_id"));
                row.put("entityName", rs.getString("entity_name"));
                row.put("diff", rs.getString("diff"));
                row.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
                rows.add(row);
            }
        } catch (Exception e) {
            throw new RuntimeException("Failed to list audit logs", e);
        }
        return rows;
    }

    public static long countByProject(UUID projectId, String entityTypeFilter) {
        StringBuilder sql = new StringBuilder("SELECT COUNT(*) FROM audit_logs WHERE project_id = ?");
        List<Object> params = new ArrayList<>();
        params.add(projectId);

        if (entityTypeFilter != null && !entityTypeFilter.isBlank()) {
            sql.append(" AND entity_type = ?");
            params.add(entityTypeFilter);
        }

        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql.toString())) {
            for (int i = 0; i < params.size(); i++) {
                ps.setObject(i + 1, params.get(i));
            }
            ResultSet rs = ps.executeQuery();
            rs.next();
            return rs.getLong(1);
        } catch (Exception e) {
            throw new RuntimeException("Failed to count audit logs", e);
        }
    }
}
