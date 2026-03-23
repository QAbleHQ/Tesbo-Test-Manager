package com.bettercases.rbac;

import com.bettercases.Database;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.Optional;
import java.util.UUID;

public final class RbacService {
    public static Optional<Role> getProjectRole(UUID userId, UUID projectId) {
        if (userId == null || projectId == null) return Optional.empty();
        String sql = "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ps.setObject(2, userId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) {
                return Optional.of(Role.fromString(rs.getString("role")));
            }
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
        return Optional.empty();
    }

    public static boolean hasProjectAccess(UUID userId, UUID projectId) {
        return getProjectRole(userId, projectId).isPresent();
    }

    public static Role requireProjectRole(UUID userId, UUID projectId) {
        return getProjectRole(userId, projectId)
                .orElseThrow(() -> new io.javalin.http.ForbiddenResponse("No access to project"));
    }
}
