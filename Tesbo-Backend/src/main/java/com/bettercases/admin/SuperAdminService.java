package com.bettercases.admin;

import com.bettercases.Database;
import com.bettercases.auth.SessionFilter;
import io.javalin.http.Context;
import io.javalin.http.ForbiddenResponse;

import java.sql.*;
import java.util.*;

public final class SuperAdminService {

    public static boolean isPlatformAdmin(UUID userId) {
        if (userId == null) return false;
        String sql = "SELECT 1 FROM platform_admins WHERE user_id = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, userId);
            return ps.executeQuery().next();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static boolean isPlatformOwner(UUID userId) {
        if (userId == null) return false;
        String sql = "SELECT 1 FROM platform_admins WHERE user_id = ? AND role = 'owner'";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, userId);
            return ps.executeQuery().next();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static UUID requirePlatformAdmin(Context ctx) {
        UUID userId = SessionFilter.getUserId(ctx)
                .orElseThrow(() -> new io.javalin.http.UnauthorizedResponse("Not authenticated"));
        if (!isPlatformAdmin(userId)) {
            throw new ForbiddenResponse("Platform admin access required");
        }
        return userId;
    }

    public static UUID requirePlatformOwner(Context ctx) {
        UUID userId = requirePlatformAdmin(ctx);
        if (!isPlatformOwner(userId)) {
            throw new ForbiddenResponse("Platform owner access required");
        }
        return userId;
    }

    public static List<Map<String, Object>> listAdmins() {
        String sql = """
            SELECT pa.id, pa.user_id, pa.role, pa.created_at,
                   u.email, u.name, u.avatar_url,
                   g.email AS granted_by_email, g.name AS granted_by_name
            FROM platform_admins pa
            JOIN users u ON pa.user_id = u.id
            LEFT JOIN users g ON pa.granted_by = g.id
            ORDER BY pa.created_at
            """;
        List<Map<String, Object>> admins = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql);
             ResultSet rs = ps.executeQuery()) {
            while (rs.next()) {
                Map<String, Object> admin = new LinkedHashMap<>();
                admin.put("id", rs.getObject("id").toString());
                admin.put("userId", rs.getObject("user_id").toString());
                admin.put("role", rs.getString("role"));
                admin.put("email", rs.getString("email"));
                admin.put("name", rs.getString("name"));
                admin.put("avatarUrl", rs.getString("avatar_url"));
                admin.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
                String grantedByEmail = rs.getString("granted_by_email");
                if (grantedByEmail != null) {
                    admin.put("grantedBy", Map.of(
                            "email", grantedByEmail,
                            "name", rs.getString("granted_by_name") != null ? rs.getString("granted_by_name") : ""
                    ));
                }
                admins.add(admin);
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return admins;
    }

    public static Map<String, Object> addAdmin(String email, UUID grantedBy) {
        String findUser = "SELECT id, email, name FROM users WHERE email = ?";
        UUID targetUserId;
        String targetName;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(findUser)) {
            ps.setString(1, email.trim().toLowerCase());
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) return null;
            targetUserId = (UUID) rs.getObject("id");
            targetName = rs.getString("name");
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }

        String insert = "INSERT INTO platform_admins (user_id, role, granted_by) VALUES (?, 'admin', ?) ON CONFLICT (user_id) DO NOTHING RETURNING id";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(insert)) {
            ps.setObject(1, targetUserId);
            ps.setObject(2, grantedBy);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) return null;
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("id", rs.getObject("id").toString());
            result.put("userId", targetUserId.toString());
            result.put("email", email.trim().toLowerCase());
            result.put("name", targetName);
            result.put("role", "admin");
            return result;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static boolean removeAdmin(UUID adminId) {
        // Cannot remove platform owners
        String checkOwner = "SELECT role FROM platform_admins WHERE id = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(checkOwner)) {
            ps.setObject(1, adminId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) return false;
            if ("owner".equals(rs.getString("role"))) return false;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }

        String sql = "DELETE FROM platform_admins WHERE id = ? AND role != 'owner'";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, adminId);
            return ps.executeUpdate() > 0;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private SuperAdminService() {}
}
