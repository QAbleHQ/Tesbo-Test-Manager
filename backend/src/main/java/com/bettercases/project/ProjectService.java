package com.bettercases.project;

import com.bettercases.Database;
import com.bettercases.ai.AiHandler;
import com.bettercases.rbac.Role;
import com.bettercases.rbac.RbacService;
import com.bettercases.suite.SuiteService;
import com.bettercases.workspace.WorkspaceService;

import java.sql.*;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

public final class ProjectService {
    /** Create a new project in the given organization; caller must be an org member. Adds creator as owner. */
    public static Map<String, Object> create(UUID orgId, UUID userId, String key, String name, String description) {
        String normalizedKey = key != null ? key.trim().toUpperCase().replaceAll("[^A-Z]", "") : "";
        if (normalizedKey.length() < 3) {
            String fromName = name != null ? name.trim().toUpperCase().replaceAll("[^A-Z]", "") : "";
            normalizedKey = fromName.length() >= 3 ? fromName.substring(0, 3) : (fromName + "PRJ").substring(0, 3);
        } else {
            normalizedKey = normalizedKey.substring(0, 3);
        }

        String sql = "INSERT INTO projects (organization_id, key, name, description) VALUES (?, ?, ?, ?) RETURNING id, key, name, created_at";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, orgId);
            ps.setString(2, normalizedKey);
            ps.setString(3, name != null ? name.trim() : "");
            ps.setString(4, description != null ? description : "");
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) throw new RuntimeException("Insert failed");
            UUID projectId = (UUID) rs.getObject("id");
            try (PreparedStatement pm = c.prepareStatement("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')")) {
                pm.setObject(1, projectId);
                pm.setObject(2, userId);
                pm.executeUpdate();
            }
            SuiteService.ensureDefaultSuiteExists(projectId);
            ensureBrowserAgentMapping(projectId, c);
            return Map.of(
                    "id", projectId.toString(),
                    "key", rs.getString("key"),
                    "name", rs.getString("name"),
                    "createdAt", rs.getTimestamp("created_at").toInstant().toString()
            );
        } catch (SQLException e) {
            if (e.getSQLState() != null && e.getSQLState().equals("23505")) {
                throw new io.javalin.http.BadRequestResponse("A project with this key already exists in your workspace.");
            }
            throw new RuntimeException(e);
        }
    }

    public static List<Map<String, Object>> listProjectsForUser(UUID userId) {
        String sql = "SELECT p.id, p.key, p.name, p.description, p.settings, p.archived_at, p.created_at, pm.role " +
                "FROM projects p JOIN project_members pm ON p.id = pm.project_id WHERE pm.user_id = ? AND p.archived_at IS NULL ORDER BY p.updated_at DESC";
        List<Map<String, Object>> out = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, userId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                out.add(Map.of(
                        "id", rs.getObject("id"),
                        "key", rs.getString("key"),
                        "name", rs.getString("name"),
                        "description", rs.getString("description") != null ? rs.getString("description") : "",
                        "role", canonicalProjectRole(rs.getString("role")),
                        "createdAt", rs.getTimestamp("created_at").toInstant().toString()
                ));
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return out;
    }

    public static Optional<Map<String, Object>> getProject(UUID projectId, UUID userId) {
        Optional<Role> roleOpt = RbacService.getProjectRole(userId, projectId);
        if (roleOpt.isEmpty()) return Optional.empty();
        String sql = "SELECT id, organization_id, key, name, description, settings, archived_at, created_at, updated_at FROM projects WHERE id = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) {
                Map<String, String> aiConfig = AiHandler.readAiConfig(projectId);
                Map<String, Object> result = new java.util.LinkedHashMap<>();
                result.put("id", rs.getObject("id").toString());
                result.put("key", rs.getString("key"));
                result.put("name", rs.getString("name"));
                result.put("description", rs.getString("description") != null ? rs.getString("description") : "");
                result.put("settings", rs.getString("settings") != null ? rs.getString("settings") : "{}");
                result.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
                result.put("updatedAt", rs.getTimestamp("updated_at").toInstant().toString());
                result.put("myRole", roleOpt.get().name().toLowerCase());
                result.put("aiConfigured", AiHandler.hasAssignedWorkspaceAiKey(projectId));
                result.put("aiProvider", aiConfig.getOrDefault("provider", ""));
                result.put("aiModel", aiConfig.getOrDefault("model", ""));
                return Optional.of(result);
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return Optional.empty();
    }

    public static void updateProject(UUID projectId, UUID userId, String name, String description, String settingsJson) {
        Role role = RbacService.requireProjectRole(userId, projectId);
        if (!role.canManageProject()) throw new io.javalin.http.ForbiddenResponse("Cannot manage project");
        String sql = "UPDATE projects SET name = ?, description = ?, settings = COALESCE(?::jsonb, settings), updated_at = now() WHERE id = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, name);
            ps.setString(2, description != null ? description : "");
            ps.setString(3, settingsJson);
            ps.setObject(4, projectId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static void deleteProject(UUID projectId, UUID userId) {
        Role role = RbacService.requireProjectRole(userId, projectId);
        if (!role.canManageProject()) throw new io.javalin.http.ForbiddenResponse("Cannot manage project");
        String sql = "DELETE FROM projects WHERE id = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            int deleted = ps.executeUpdate();
            if (deleted == 0) {
                throw new io.javalin.http.NotFoundResponse("Project not found");
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static List<Map<String, Object>> listMembers(UUID projectId, UUID userId) {
        RbacService.requireProjectRole(userId, projectId);
        String sql = "SELECT u.id AS user_id, u.email AS user_email, u.name AS user_name, pm.role AS member_role, pm.created_at AS joined_at " +
                "FROM project_members pm JOIN users u ON pm.user_id = u.id WHERE pm.project_id = ? ORDER BY pm.created_at";
        List<Map<String, Object>> out = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                out.add(Map.of(
                        "userId", rs.getObject("user_id").toString(),
                        "email", rs.getString("user_email"),
                        "name", rs.getString("user_name") != null ? rs.getString("user_name") : "",
                        "role", canonicalProjectRole(rs.getString("member_role")),
                        "joinedAt", rs.getTimestamp("joined_at").toInstant().toString()
                ));
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return out;
    }

    public static void addMember(UUID projectId, UUID actorId, UUID targetUserId, String role) {
        Role actorRole = RbacService.requireProjectRole(actorId, projectId);
        if (!actorRole.canManageMembers()) throw new io.javalin.http.ForbiddenResponse("Cannot manage members");
        if (!WorkspaceService.isUserInProjectOrganization(projectId, targetUserId)) {
            throw new io.javalin.http.BadRequestResponse("User must be a workspace team member before they can be allocated to this project.");
        }
        String normalizedRole = normalizeProjectRole(role);
        String targetCurrentRole = getProjectMemberRole(projectId, targetUserId).orElse(null);
        if (actorRole == Role.MANAGER && !"member".equals(normalizedRole)) {
            throw new io.javalin.http.ForbiddenResponse("Managers can only invite members.");
        }
        if (actorRole == Role.MANAGER && ("owner".equals(targetCurrentRole) || "admin".equals(targetCurrentRole))) {
            throw new io.javalin.http.ForbiddenResponse("Managers cannot edit owner/admin members.");
        }
        if (actorRole == Role.ADMIN && ("owner".equals(normalizedRole) || "admin".equals(normalizedRole))) {
            throw new io.javalin.http.ForbiddenResponse("Admins cannot add or promote owner/admin members.");
        }
        if (actorRole == Role.ADMIN && ("owner".equals(targetCurrentRole) || "admin".equals(targetCurrentRole))) {
            throw new io.javalin.http.ForbiddenResponse("Admins cannot edit owner/admin members.");
        }
        String sql = "INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ps.setObject(2, targetUserId);
            ps.setString(3, normalizedRole);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static void removeMember(UUID projectId, UUID actorId, UUID targetUserId) {
        Role actorRole = RbacService.requireProjectRole(actorId, projectId);
        if (!actorRole.canManageMembers()) throw new io.javalin.http.ForbiddenResponse("Cannot manage members");
        String targetRole = getProjectMemberRole(projectId, targetUserId).orElse(null);
        if ("owner".equals(targetRole)) {
            throw new io.javalin.http.ForbiddenResponse("Owner members cannot be removed from project");
        }
        if (actorRole == Role.ADMIN && "admin".equals(targetRole)) {
            throw new io.javalin.http.ForbiddenResponse("Admins cannot remove admin members.");
        }
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("DELETE FROM project_members WHERE project_id = ? AND user_id = ?")) {
            ps.setObject(1, projectId);
            ps.setObject(2, targetUserId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static Optional<String> getProjectMemberRole(UUID projectId, UUID userId) {
        String sql = "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ps.setObject(2, userId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) {
                return Optional.ofNullable(canonicalProjectRole(rs.getString("role")));
            }
            return Optional.empty();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static String canonicalProjectRole(String role) {
        if (role == null) return "member";
        String normalized = role.trim().toLowerCase().replace("-", "_").replace(" ", "_");
        if ("project_admin".equals(normalized)) return "admin";
        if ("test_manager".equals(normalized)) return "manager";
        if ("qa_member".equals(normalized)) return "member";
        if ("viewer".equals(normalized)) return "member";
        return normalized;
    }

    private static void ensureBrowserAgentMapping(UUID projectId, Connection c) throws SQLException {
        String automationJson = "{\"automation\":{\"browserAgent\":\"default\"}}";
        try (PreparedStatement ps = c.prepareStatement(
                "UPDATE projects SET settings = COALESCE(settings, '{}'::jsonb) || ?::jsonb, updated_at = now() WHERE id = ?")) {
            ps.setString(1, automationJson);
            ps.setObject(2, projectId);
            ps.executeUpdate();
        }
    }

    private static String normalizeProjectRole(String role) {
        if (role == null || role.isBlank()) {
            throw new io.javalin.http.BadRequestResponse("Project role is required");
        }
        String normalized = canonicalProjectRole(role);
        if (!Set.of("owner", "admin", "manager", "member").contains(normalized)) {
            throw new io.javalin.http.BadRequestResponse("Invalid project role");
        }
        return normalized;
    }
}
