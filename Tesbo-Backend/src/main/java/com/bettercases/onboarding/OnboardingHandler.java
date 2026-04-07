package com.bettercases.onboarding;

import com.bettercases.Database;
import com.bettercases.audit.AuditService;
import com.bettercases.auth.SessionFilter;
import io.javalin.http.Context;

import java.sql.*;
import java.util.Map;
import java.util.UUID;

public final class OnboardingHandler {
    public static void createWorkspace(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        CreateWorkspaceRequest req = ctx.bodyAsClass(CreateWorkspaceRequest.class);
        if (req == null || req.orgName == null || req.orgName.isBlank()) {
            ctx.status(400).json(Map.of("error", "orgName required"));
            return;
        }
        String orgName = req.orgName.trim();
        String orgSlug = slugify(orgName);

        if (userAlreadyOwnsWorkspace(userId)) {
            ctx.status(409).json(Map.of("error", "You already have a workspace. Go to Projects."));
            return;
        }

        try (Connection c = Database.getDataSource().getConnection()) {
            c.setAutoCommit(false);
            try {
                UUID orgId = insertOrg(c, orgName, orgSlug);
                insertOrgMember(c, orgId, userId, "owner");
                c.commit();
                try {
                    AuditService.log(userId, "workspace_created", "organization", orgId.toString(), "{}", ctx.ip(), ctx.userAgent());
                } catch (Exception auditEx) {
                    System.err.println("Audit log failed (workspace creation still succeeded): " + auditEx.getMessage());
                }
                ctx.status(201).json(Map.of(
                        "organizationId", orgId.toString()
                ));
            } catch (SQLException e) {
                c.rollback();
                if ("23505".equals(e.getSQLState())) {
                    ctx.status(409).json(Map.of("error", "You already have a workspace. Go to Projects."));
                    return;
                }
                throw new RuntimeException(e);
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static void createOrgAndProject(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        CreateRequest req = ctx.bodyAsClass(CreateRequest.class);
        if (req == null || req.orgName == null || req.orgName.isBlank() || req.projectKey == null || req.projectKey.isBlank() || req.projectName == null || req.projectName.isBlank()) {
            ctx.status(400).json(Map.of("error", "orgName, projectKey, projectName required"));
            return;
        }
        String orgSlug = slugify(req.orgName);
        String projectKey = req.projectKey.trim().toUpperCase().replaceAll("[^A-Z0-9]", "");
        if (projectKey.isEmpty()) projectKey = "PROJ";
        projectKey = projectKey.substring(0, Math.min(32, projectKey.length()));

        try (Connection c = Database.getDataSource().getConnection()) {
            c.setAutoCommit(false);
            try {
                UUID orgId = insertOrg(c, req.orgName, orgSlug);
                insertOrgMember(c, orgId, userId, "owner");
                UUID projectId = insertProject(c, orgId, projectKey, req.projectName, req.projectDescription);
                insertProjectMember(c, projectId, userId, "owner");
                updateUserDefaultProject(c, userId, projectId);
                c.commit();
                try {
                    AuditService.log(userId, "onboarding_complete", "organization", orgId.toString(), "{}", ctx.ip(), ctx.userAgent());
                } catch (Exception auditEx) {
                    System.err.println("Audit log failed (onboarding still succeeded): " + auditEx.getMessage());
                }
                ctx.json(Map.of(
                        "organizationId", orgId.toString(),
                        "projectId", projectId.toString(),
                        "projectKey", projectKey
                ));
            } catch (SQLException e) {
                c.rollback();
                if ("23505".equals(e.getSQLState())) {
                    ctx.status(409).json(Map.of("error", "You already have a workspace. Go to Projects or use a different workspace name or project key."));
                    return;
                }
                throw new RuntimeException(e);
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static String slugify(String name) {
        String slug = name.trim().toLowerCase().replaceAll("[^a-z0-9]+", "-").replaceAll("^-|-$", "");
        return slug.isEmpty() ? "org" : slug.substring(0, Math.min(64, slug.length()));
    }

    private static UUID insertOrg(Connection c, String name, String slug) throws SQLException {
        String sql = "INSERT INTO organizations (name, slug) VALUES (?, ?) RETURNING id";
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, name);
            ps.setString(2, slug);
            ResultSet rs = ps.executeQuery();
            rs.next();
            return (UUID) rs.getObject("id");
        }
    }

    private static boolean userAlreadyOwnsWorkspace(UUID userId) {
        String sql = """
                SELECT 1
                FROM organization_members
                WHERE user_id = ?
                LIMIT 1
                """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, userId);
            ResultSet rs = ps.executeQuery();
            return rs.next();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static void insertOrgMember(Connection c, UUID orgId, UUID userId, String role) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)")) {
            ps.setObject(1, orgId);
            ps.setObject(2, userId);
            ps.setString(3, role);
            ps.executeUpdate();
        }
    }

    private static UUID insertProject(Connection c, UUID orgId, String key, String name, String description) throws SQLException {
        String sql = "INSERT INTO projects (organization_id, key, name, description) VALUES (?, ?, ?, ?) RETURNING id";
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, orgId);
            ps.setString(2, key);
            ps.setString(3, name);
            ps.setString(4, description != null ? description : "");
            ResultSet rs = ps.executeQuery();
            rs.next();
            UUID projectId = (UUID) rs.getObject("id");
            insertDefaultSuite(c, projectId);
            return projectId;
        }
    }

    private static void insertDefaultSuite(Connection c, UUID projectId) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement("INSERT INTO suites (project_id, parent_id, name, position) VALUES (?, NULL, 'Default Suite', 0)")) {
            ps.setObject(1, projectId);
            ps.executeUpdate();
        }
    }

    private static void insertProjectMember(Connection c, UUID projectId, UUID userId, String role) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)")) {
            ps.setObject(1, projectId);
            ps.setObject(2, userId);
            ps.setString(3, role);
            ps.executeUpdate();
        }
    }

    private static void updateUserDefaultProject(Connection c, UUID userId, UUID projectId) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement("UPDATE users SET default_project_id = ?, updated_at = now() WHERE id = ?")) {
            ps.setObject(1, projectId);
            ps.setObject(2, userId);
            ps.executeUpdate();
        }
    }

    public static class CreateRequest {
        public String orgName;
        public String projectKey;
        public String projectName;
        public String projectDescription;
    }

    public static class CreateWorkspaceRequest {
        public String orgName;
    }
}
