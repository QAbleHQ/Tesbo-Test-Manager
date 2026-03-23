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
    private static final Set<String> WORKSPACE_MEMBER_ROLES = Set.of("owner", "admin", "manager", "member");
    private static final Set<String> PROJECT_MEMBER_ROLES = Set.of("owner", "admin", "manager", "member", "viewer");

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
        String actorRole = getOrgRole(orgId, actorId);
        if (!Set.of("owner", "admin", "manager").contains(actorRole)) {
            throw new io.javalin.http.ForbiddenResponse("Insufficient permission in workspace");
        }
        if (targetUserId.equals(actorId) && !"owner".equals(actorRole)) {
            throw new io.javalin.http.ForbiddenResponse("Cannot change own role");
        }
        String normalizedRole = normalizeWorkspaceRole(role);
        String targetCurrentRole = getOrgRole(orgId, targetUserId);
        if ("manager".equals(actorRole) && !"member".equals(normalizedRole)) {
            throw new io.javalin.http.ForbiddenResponse("Managers can only invite members.");
        }
        if ("manager".equals(actorRole) && ("owner".equals(targetCurrentRole) || "admin".equals(targetCurrentRole))) {
            throw new io.javalin.http.ForbiddenResponse("Managers cannot edit owner or admin users.");
        }
        if ("admin".equals(actorRole) && ("owner".equals(normalizedRole) || "admin".equals(normalizedRole))) {
            throw new io.javalin.http.ForbiddenResponse("Admins cannot add or promote owner/admin users.");
        }
        if ("admin".equals(actorRole) && ("owner".equals(targetCurrentRole) || "admin".equals(targetCurrentRole))) {
            throw new io.javalin.http.ForbiddenResponse("Admins cannot edit owner/admin users.");
        }
        String sql = "INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, orgId);
            ps.setObject(2, targetUserId);
            ps.setString(3, normalizedRole);
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
        String actorRole = getOrgRole(orgId, actorId);
        if (!Set.of("owner", "admin").contains(actorRole)) {
            throw new io.javalin.http.ForbiddenResponse("Insufficient permission in workspace");
        }
        if (targetUserId.equals(actorId)) {
            throw new io.javalin.http.ForbiddenResponse("Cannot remove yourself from workspace");
        }
        String targetRole = getOrgRole(orgId, targetUserId);
        if ("owner".equals(targetRole)) {
            throw new io.javalin.http.ForbiddenResponse("Owner users cannot be deleted from workspace");
        }
        if ("admin".equals(actorRole) && "admin".equals(targetRole)) {
            throw new io.javalin.http.ForbiddenResponse("Admins cannot delete admin users from workspace");
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
                    projectRoles.put(projectId.toString(), canonicalProjectRole(rs.getString("project_role")));
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
        String actorRole = getOrgRole(orgId, actorId);
        String normalizedRole = normalizeProjectRole(role);
        String targetCurrentRole = getProjectMemberRole(projectId, targetUserId).orElse(null);
        if ("manager".equals(actorRole) && !"member".equals(normalizedRole)) {
            throw new io.javalin.http.ForbiddenResponse("Managers can only invite members.");
        }
        if ("manager".equals(actorRole) && ("owner".equals(targetCurrentRole) || "admin".equals(targetCurrentRole))) {
            throw new io.javalin.http.ForbiddenResponse("Managers cannot edit owner/admin members.");
        }
        if ("admin".equals(actorRole) && ("owner".equals(normalizedRole) || "admin".equals(normalizedRole))) {
            throw new io.javalin.http.ForbiddenResponse("Admins cannot add or promote owner/admin members.");
        }
        if ("admin".equals(actorRole) && ("owner".equals(targetCurrentRole) || "admin".equals(targetCurrentRole))) {
            throw new io.javalin.http.ForbiddenResponse("Admins cannot edit owner/admin members.");
        }
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
        String actorRole = getOrgRole(orgId, actorId);
        requireProjectInOrganization(projectId, orgId);
        String targetRole = getProjectMemberRole(projectId, targetUserId).orElse(null);
        if ("owner".equals(targetRole)) {
            throw new io.javalin.http.ForbiddenResponse("Owner members cannot be removed from project");
        }
        if ("admin".equals(actorRole) && "admin".equals(targetRole)) {
            throw new io.javalin.http.ForbiddenResponse("Admins cannot remove admin members.");
        }
        if ("manager".equals(actorRole) && ("admin".equals(targetRole) || "owner".equals(targetRole))) {
            throw new io.javalin.http.ForbiddenResponse("Managers cannot remove owner/admin members.");
        }
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

    public static Map<String, Object> listWorkspaceAiKeys(UUID orgId, UUID actorId) {
        requireOrgMember(orgId, actorId);
        List<Map<String, Object>> keys = new ArrayList<>();
        String keysSql = """
                SELECT id, name, provider, default_model, is_active, created_at, updated_at, api_key
                FROM workspace_ai_keys
                WHERE organization_id = ?
                ORDER BY created_at DESC
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(keysSql)) {
            ps.setObject(1, orgId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                String rawKey = rs.getString("api_key");
                keys.add(Map.of(
                        "id", rs.getObject("id").toString(),
                        "name", rs.getString("name"),
                        "provider", rs.getString("provider"),
                        "defaultModel", rs.getString("default_model") == null ? "" : rs.getString("default_model"),
                        "active", rs.getBoolean("is_active"),
                        "maskedKey", maskApiKey(rawKey),
                        "createdAt", rs.getTimestamp("created_at").toInstant().toString(),
                        "updatedAt", rs.getTimestamp("updated_at").toInstant().toString()
                ));
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }

        List<Map<String, Object>> projects = new ArrayList<>();
        String projectsSql = """
                SELECT p.id, p.key, p.name, a.workspace_ai_key_id
                FROM projects p
                LEFT JOIN project_ai_key_allocations a ON a.project_id = p.id
                WHERE p.organization_id = ? AND p.archived_at IS NULL
                ORDER BY p.created_at
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(projectsSql)) {
            ps.setObject(1, orgId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                Object allocated = rs.getObject("workspace_ai_key_id");
                projects.add(Map.of(
                        "projectId", rs.getObject("id").toString(),
                        "projectKey", rs.getString("key"),
                        "projectName", rs.getString("name"),
                        "workspaceAiKeyId", allocated == null ? "" : allocated.toString()
                ));
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return Map.of("keys", keys, "projects", projects);
    }

    public static Map<String, Object> createWorkspaceAiKey(
            UUID orgId,
            UUID actorId,
            String name,
            String provider,
            String apiKey,
            String defaultModel
    ) {
        requireOrgRole(orgId, actorId, "owner");
        String normalizedName = name == null ? "" : name.trim();
        String normalizedProvider = normalizeAiProvider(provider);
        String normalizedKey = apiKey == null ? "" : apiKey.trim();
        String normalizedModel = defaultModel == null ? "" : defaultModel.trim();
        if (normalizedName.isBlank()) {
            throw new io.javalin.http.BadRequestResponse("Key name is required.");
        }
        if (normalizedKey.isBlank()) {
            throw new io.javalin.http.BadRequestResponse("API key is required.");
        }

        String sql = """
                INSERT INTO workspace_ai_keys (organization_id, name, provider, api_key, default_model, is_active, created_by, updated_at)
                VALUES (?, ?, ?, ?, ?, true, ?, now())
                RETURNING id, name, provider, default_model, is_active, created_at, updated_at, api_key
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, orgId);
            ps.setString(2, normalizedName);
            ps.setString(3, normalizedProvider);
            ps.setString(4, normalizedKey);
            ps.setString(5, normalizedModel.isBlank() ? null : normalizedModel);
            ps.setObject(6, actorId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) throw new RuntimeException("Failed to create workspace AI key");
            return Map.of(
                    "id", rs.getObject("id").toString(),
                    "name", rs.getString("name"),
                    "provider", rs.getString("provider"),
                    "defaultModel", rs.getString("default_model") == null ? "" : rs.getString("default_model"),
                    "active", rs.getBoolean("is_active"),
                    "maskedKey", maskApiKey(rs.getString("api_key")),
                    "createdAt", rs.getTimestamp("created_at").toInstant().toString(),
                    "updatedAt", rs.getTimestamp("updated_at").toInstant().toString()
            );
        } catch (SQLException e) {
            if ("23505".equals(e.getSQLState())) {
                throw new io.javalin.http.BadRequestResponse("A key with this name already exists in your workspace.");
            }
            throw new RuntimeException(e);
        }
    }

    public static void deleteWorkspaceAiKey(UUID orgId, UUID actorId, UUID keyId) {
        requireOrgRole(orgId, actorId, "owner");
        String sql = "DELETE FROM workspace_ai_keys WHERE id = ? AND organization_id = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, keyId);
            ps.setObject(2, orgId);
            int affected = ps.executeUpdate();
            if (affected == 0) {
                throw new io.javalin.http.NotFoundResponse("Workspace AI key not found.");
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static void allocateWorkspaceAiKeyToProject(
            UUID orgId,
            UUID actorId,
            UUID projectId,
            UUID keyId
    ) {
        requireOrgRole(orgId, actorId, "owner");
        requireProjectInOrganization(projectId, orgId);
        if (keyId != null) {
            String keySql = "SELECT 1 FROM workspace_ai_keys WHERE id = ? AND organization_id = ? AND is_active = true";
            try (Connection c = Database.getDataSource().getConnection();
                 PreparedStatement ps = c.prepareStatement(keySql)) {
                ps.setObject(1, keyId);
                ps.setObject(2, orgId);
                ResultSet rs = ps.executeQuery();
                if (!rs.next()) {
                    throw new io.javalin.http.BadRequestResponse("Selected AI key does not belong to this workspace.");
                }
            } catch (SQLException e) {
                throw new RuntimeException(e);
            }
        }
        String sql = """
                INSERT INTO project_ai_key_allocations (project_id, workspace_ai_key_id, allocated_by, updated_at)
                VALUES (?, ?, ?, now())
                ON CONFLICT (project_id) DO UPDATE
                SET workspace_ai_key_id = EXCLUDED.workspace_ai_key_id,
                    allocated_by = EXCLUDED.allocated_by,
                    updated_at = now()
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ps.setObject(2, keyId);
            ps.setObject(3, actorId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static String normalizeAiProvider(String provider) {
        String normalized = provider == null ? "" : provider.trim().toLowerCase();
        if (!"openai".equals(normalized) && !"anthropic".equals(normalized)) {
            throw new io.javalin.http.BadRequestResponse("provider must be openai or anthropic");
        }
        return normalized;
    }

    private static String maskApiKey(String apiKey) {
        if (apiKey == null || apiKey.isBlank()) return "";
        String trimmed = apiKey.trim();
        if (trimmed.length() <= 8) return "********";
        return trimmed.substring(0, 4) + "..." + trimmed.substring(trimmed.length() - 4);
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
        String normalized = role.trim().toLowerCase().replace("-", "_").replace(" ", "_");
        if ("project_admin".equals(normalized)) normalized = "admin";
        if ("test_manager".equals(normalized)) normalized = "manager";
        if ("qa_member".equals(normalized)) normalized = "member";
        if ("viewer".equals(normalized)) normalized = "member";
        if (!PROJECT_MEMBER_ROLES.contains(normalized)) {
            throw new io.javalin.http.BadRequestResponse("Invalid project role");
        }
        return normalized;
    }

    private static String normalizeWorkspaceRole(String role) {
        String normalized = role == null ? "member" : role.trim().toLowerCase();
        if (normalized.isBlank()) normalized = "member";
        if (!WORKSPACE_MEMBER_ROLES.contains(normalized)) {
            throw new io.javalin.http.BadRequestResponse("Invalid workspace role");
        }
        return normalized;
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

    public static void requireCanCreateProject(UUID orgId, UUID actorId) {
        requireOrgRole(orgId, actorId, "owner", "admin", "manager");
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
