package com.bettercases.workspace;

import com.bettercases.Database;
import com.bettercases.invitation.InvitationService;

import java.sql.*;
import java.util.*;

/**
 * Workspace = Organization. When a user completes onboarding, a workspace (org) is created
 * with one initial project. Workspace has team members (organization_members).
 * Project access is by allocation: only workspace members can be added to projects (project_members).
 */
public final class WorkspaceService {
    private static final Set<String> PROJECT_MEMBER_ROLES = Set.of("viewer", "qa_member", "test_manager", "project_admin");

    /** Returns the first organization the user belongs to (their workspace). */
    public static Optional<Map<String, Object>> getCurrentUserWorkspace(UUID userId) {
        String sql = "SELECT o.id, o.name, o.slug, o.created_at, om.role " +
                "FROM organizations o " +
                "JOIN organization_members om ON o.id = om.organization_id " +
                "WHERE om.user_id = ? " +
                "ORDER BY om.created_at ASC LIMIT 1";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, userId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) {
                return Optional.of(Map.<String, Object>of(
                        "id", rs.getObject("id").toString(),
                        "name", rs.getString("name"),
                        "slug", rs.getString("slug"),
                        "role", rs.getString("role"),
                        "createdAt", rs.getTimestamp("created_at").toInstant().toString()
                ));
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return Optional.empty();
    }

    public static Optional<UUID> getCurrentUserOrganizationId(UUID userId) {
        return getCurrentUserWorkspace(userId).map(w -> UUID.fromString((String) w.get("id")));
    }

    /** List workspace (organization) members. Caller must be an org member. */
    public static List<Map<String, Object>> listWorkspaceMembers(UUID orgId, UUID actorId) {
        requireOrgMember(orgId, actorId);
        String sql = "SELECT u.id AS user_id, u.email AS user_email, u.name AS user_name, om.role AS member_role, om.created_at AS joined_at " +
                "FROM organization_members om " +
                "JOIN users u ON om.user_id = u.id " +
                "WHERE om.organization_id = ? ORDER BY om.created_at";
        List<Map<String, Object>> out = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, orgId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                out.add(Map.of(
                        "userId", rs.getObject("user_id").toString(),
                        "email", rs.getString("user_email"),
                        "name", rs.getString("user_name") != null ? rs.getString("user_name") : "",
                        "role", rs.getString("member_role"),
                        "joinedAt", rs.getTimestamp("joined_at").toInstant().toString()
                ));
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return out;
    }

    /** Add a user to the workspace. If email is provided, look up user by email (or create invitation later). For now we support userId. */
    public static void addWorkspaceMember(UUID orgId, UUID actorId, UUID targetUserId, String role) {
        requireOrgRole(orgId, actorId, "owner", "admin", "manager");
        if (targetUserId.equals(actorId) && !"owner".equals(getOrgRole(orgId, actorId))) {
            throw new io.javalin.http.ForbiddenResponse("Cannot change own role");
        }
        String sql = "INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, orgId);
            ps.setObject(2, targetUserId);
            ps.setString(3, role != null && !role.isBlank() ? role : "member");
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    /** Add workspace member by email: add directly for existing users, otherwise send invitation email. */
    public static void addWorkspaceMemberByEmail(UUID orgId, UUID actorId, String email, String role) {
        Optional<UUID> targetUserId = findUserIdByEmail(email);
        if (targetUserId.isEmpty()) {
            InvitationService.createWorkspaceInvitation(orgId, actorId, email, role);
            return;
        }
        addWorkspaceMember(orgId, actorId, targetUserId.get(), role);
    }

    public static void removeWorkspaceMember(UUID orgId, UUID actorId, UUID targetUserId) {
        requireOrgRole(orgId, actorId, "owner", "admin");
        if (targetUserId.equals(actorId)) {
            throw new io.javalin.http.ForbiddenResponse("Cannot remove yourself from workspace");
        }
        String targetRole = getOrgRole(orgId, targetUserId);
        if ("admin".equals(targetRole)) {
            throw new io.javalin.http.ForbiddenResponse("Admin users cannot be deleted from workspace");
        }
        String sql = "DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, orgId);
            ps.setObject(2, targetUserId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    /** Check that target user is in the same organization as the project (so only workspace members can be allocated to projects). */
    public static boolean isUserInProjectOrganization(UUID projectId, UUID userId) {
        String sql = "SELECT 1 FROM projects p " +
                "JOIN organization_members om ON om.organization_id = p.organization_id AND om.user_id = ? " +
                "WHERE p.id = ? AND p.organization_id IS NOT NULL";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, userId);
            ps.setObject(2, projectId);
            ResultSet rs = ps.executeQuery();
            return rs.next();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    /** Workspace-level project access matrix for admins (members x projects with roles). */
    public static Map<String, Object> listWorkspaceProjectAccess(UUID orgId, UUID actorId) {
        requireOrgRole(orgId, actorId, "owner", "admin", "manager");

        List<Map<String, Object>> projects = new ArrayList<>();
        String projectSql = "SELECT id, key, name FROM projects WHERE organization_id = ? AND archived_at IS NULL ORDER BY created_at";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(projectSql)) {
            ps.setObject(1, orgId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                projects.add(Map.of(
                        "id", rs.getObject("id").toString(),
                        "key", rs.getString("key"),
                        "name", rs.getString("name")
                ));
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }

        String memberSql = "SELECT u.id AS user_id, u.email, u.name, om.role AS workspace_role, pm.project_id, pm.role AS project_role " +
                "FROM organization_members om " +
                "JOIN users u ON u.id = om.user_id " +
                "LEFT JOIN project_members pm ON pm.user_id = u.id AND pm.project_id IN (SELECT id FROM projects WHERE organization_id = ?) " +
                "WHERE om.organization_id = ? " +
                "ORDER BY om.created_at";
        Map<String, Map<String, Object>> byUser = new LinkedHashMap<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(memberSql)) {
            ps.setObject(1, orgId);
            ps.setObject(2, orgId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                String userId = rs.getObject("user_id").toString();
                Map<String, Object> row = byUser.get(userId);
                if (row == null) {
                    row = new LinkedHashMap<>();
                    row.put("userId", userId);
                    row.put("email", rs.getString("email"));
                    row.put("name", rs.getString("name") != null ? rs.getString("name") : "");
                    row.put("workspaceRole", rs.getString("workspace_role"));
                    row.put("projectRoles", new HashMap<String, String>());
                    byUser.put(userId, row);
                }
                Object projectId = rs.getObject("project_id");
                if (projectId != null) {
                    @SuppressWarnings("unchecked")
                    Map<String, String> projectRoles = (Map<String, String>) row.get("projectRoles");
                    projectRoles.put(projectId.toString(), rs.getString("project_role"));
                }
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }

        return Map.of(
                "projects", projects,
                "members", new ArrayList<>(byUser.values())
        );
    }

    public static void setWorkspaceProjectAccess(UUID orgId, UUID actorId, UUID projectId, UUID targetUserId, String role) {
        requireOrgRole(orgId, actorId, "owner", "admin", "manager");
        String normalizedRole = normalizeProjectRole(role);
        requireProjectInOrganization(projectId, orgId);
        requireWorkspaceMember(orgId, targetUserId);
        String sql = "INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?) " +
                "ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role";
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

    public static void removeWorkspaceProjectAccess(UUID orgId, UUID actorId, UUID projectId, UUID targetUserId) {
        requireOrgRole(orgId, actorId, "owner", "admin", "manager");
        requireProjectInOrganization(projectId, orgId);
        String sql = "DELETE FROM project_members WHERE project_id = ? AND user_id = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ps.setObject(2, targetUserId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static Optional<UUID> findUserIdByEmail(String email) {
        if (email == null || (email = email.trim().toLowerCase()).isEmpty()) return Optional.empty();
        String sql = "SELECT id FROM users WHERE email = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, email);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) return Optional.of((UUID) rs.getObject("id"));
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return Optional.empty();
    }

    private static void requireWorkspaceMember(UUID orgId, UUID userId) {
        String sql = "SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, orgId);
            ps.setObject(2, userId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) {
                throw new io.javalin.http.BadRequestResponse("User must be a workspace member before project access can be granted.");
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static void requireProjectInOrganization(UUID projectId, UUID orgId) {
        String sql = "SELECT 1 FROM projects WHERE id = ? AND organization_id = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ps.setObject(2, orgId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) {
                throw new io.javalin.http.BadRequestResponse("Project does not belong to your workspace");
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static String normalizeProjectRole(String role) {
        if (role == null || role.isBlank()) {
            throw new io.javalin.http.BadRequestResponse("Project role is required");
        }
        String normalized = role.trim().toLowerCase();
        if (!PROJECT_MEMBER_ROLES.contains(normalized)) {
            throw new io.javalin.http.BadRequestResponse("Invalid project role");
        }
        return normalized;
    }

    public static void requireCanCreateProject(UUID orgId, UUID actorId) {
        requireOrgRole(orgId, actorId, "owner", "manager");
    }

    private static void requireOrgMember(UUID orgId, UUID userId) {
        String sql = "SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, orgId);
            ps.setObject(2, userId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) {
                throw new io.javalin.http.ForbiddenResponse("Not a member of this workspace");
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static String getOrgRole(UUID orgId, UUID userId) {
        String sql = "SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, orgId);
            ps.setObject(2, userId);
            ResultSet rs = ps.executeQuery();
            return rs.next() ? rs.getString("role") : null;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static void requireOrgRole(UUID orgId, UUID userId, String... allowedRoles) {
        String role = getOrgRole(orgId, userId);
        if (role == null) throw new io.javalin.http.ForbiddenResponse("Not a member of this workspace");
        for (String allowed : allowedRoles) {
            if (allowed.equals(role)) return;
        }
        throw new io.javalin.http.ForbiddenResponse("Insufficient permission in workspace");
    }
}
