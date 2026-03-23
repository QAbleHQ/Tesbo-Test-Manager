package com.bettercases.notifications;

import com.bettercases.Database;

import java.sql.*;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class NotificationService {
    public static List<Map<String, Object>> listForUser(UUID userId, int limit, boolean unreadOnly) {
        String sql = "SELECT id, type, title, body, link_entity_type, link_entity_id, read_at, created_at FROM notifications WHERE user_id = ?";
        if (unreadOnly) sql += " AND read_at IS NULL";
        sql += " ORDER BY created_at DESC LIMIT ?";
        List<Map<String, Object>> out = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, userId);
            ps.setInt(2, limit);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                Map<String, Object> m = new HashMap<>();
                m.put("id", rs.getObject("id").toString());
                m.put("type", rs.getString("type"));
                m.put("title", rs.getString("title"));
                m.put("body", rs.getString("body") != null ? rs.getString("body") : "");
                m.put("linkEntityType", rs.getString("link_entity_type") != null ? rs.getString("link_entity_type") : "");
                m.put("linkEntityId", rs.getString("link_entity_id") != null ? rs.getString("link_entity_id") : "");
                m.put("readAt", rs.getTimestamp("read_at") != null ? rs.getTimestamp("read_at").toInstant().toString() : null);
                m.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
                out.add(m);
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return out;
    }

    public static void markRead(UUID notificationId, UUID userId) {
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("UPDATE notifications SET read_at = now() WHERE id = ? AND user_id = ?")) {
            ps.setObject(1, notificationId);
            ps.setObject(2, userId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static void create(UUID userId, String type, String title, String body, String linkEntityType, String linkEntityId) {
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("INSERT INTO notifications (user_id, type, title, body, link_entity_type, link_entity_id) VALUES (?, ?, ?, ?, ?, ?)")) {
            ps.setObject(1, userId);
            ps.setString(2, type);
            ps.setString(3, title);
            ps.setString(4, body);
            ps.setString(5, linkEntityType);
            ps.setString(6, linkEntityId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }
}
