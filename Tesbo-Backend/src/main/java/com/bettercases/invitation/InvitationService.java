package com.bettercases.invitation;

import com.bettercases.Config;
import com.bettercases.Database;
import com.bettercases.auth.EmailService;

import java.security.SecureRandom;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

public final class InvitationService {
    private static final int INVITATION_EXPIRY_HOURS = 24;
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final EmailService EMAIL_SERVICE = new EmailService();
    private static final Set<String> WORKSPACE_ROLES = Set.of("member", "manager", "admin", "owner");
    private static final Set<String> PROJECT_ROLES = Set.of("member", "manager", "admin", "owner", "viewer");

    private InvitationService() {}

    public static Map<String, Object> createWorkspaceInvitation(UUID orgId, UUID actorId, String email, String role) {
        requireOrgRole(orgId, actorId, "owner", "admin", "manager");
        String normalizedEmail = normalizeEmail(email);
        String normalizedRole = normalizeWorkspaceRole(role);
        String actorRole = getOrgRole(orgId, actorId);
        if ("manager".equals(actorRole) && !"member".equals(normalizedRole)) {
            throw new io.javalin.http.ForbiddenResponse("Managers can only invite members.");
        }
        if ("admin".equals(actorRole) && ("owner".equals(normalizedRole) || "admin".equals(normalizedRole))) {
            throw new io.javalin.http.ForbiddenResponse("Admins cannot invite owner/admin users.");
        }

        PendingInvitation existing = findPendingWorkspaceInvitation(orgId, normalizedEmail);
        PendingInvitation invitation = existing != null ? existing : insertWorkspaceInvitation(orgId, normalizedEmail, normalizedRole);

        String orgName = getOrganizationName(orgId);
        sendWorkspaceInvitationEmail(normalizedEmail, orgName, invitation.token);

        return Map.of(
                "id", invitation.id.toString(),
                "email", normalizedEmail,
                "role", normalizedRole,
                "expiresAt", invitation.expiresAt.toString(),
                "createdAt", invitation.createdAt.toString()
        );
    }

    public static List<Map<String, Object>> listPendingWorkspaceInvitations(UUID orgId, UUID actorId) {
        requireOrgRole(orgId, actorId, "owner", "admin", "manager");
        String sql = "SELECT id, email, role, expires_at, created_at " +
                "FROM invitations WHERE organization_id = ? AND project_id IS NULL AND accepted_at IS NULL AND expires_at > now() " +
                "ORDER BY created_at DESC";
        List<Map<String, Object>> out = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, orgId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                out.add(Map.of(
                        "id", rs.getObject("id").toString(),
                        "email", rs.getString("email"),
                        "role", rs.getString("role"),
                        "expiresAt", rs.getTimestamp("expires_at").toInstant().toString(),
                        "createdAt", rs.getTimestamp("created_at").toInstant().toString()
                ));
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return out;
    }

    public static void revokeWorkspaceInvitation(UUID orgId, UUID actorId, UUID invitationId) {
        requireOrgRole(orgId, actorId, "owner", "admin", "manager");
        String sql = "DELETE FROM invitations WHERE id = ? AND organization_id = ? AND project_id IS NULL AND accepted_at IS NULL";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, invitationId);
            ps.setObject(2, orgId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static Map<String, Object> getInvitationByToken(String token) {
        String normalizedToken = normalizeToken(token);
        String sql = "SELECT i.id, i.organization_id, i.project_id, i.email, i.role, i.expires_at, i.accepted_at, i.created_at, " +
                "o.name AS organization_name, p.name AS project_name " +
                "FROM invitations i " +
                "LEFT JOIN organizations o ON o.id = i.organization_id " +
                "LEFT JOIN projects p ON p.id = i.project_id " +
                "WHERE i.token = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, normalizedToken);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) {
                throw new io.javalin.http.NotFoundResponse("Invitation not found");
            }
            return toInvitationResponse(rs);
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static Map<String, Object> acceptInvitation(String token, UUID userId) {
        String normalizedToken = normalizeToken(token);
        try (Connection c = Database.getDataSource().getConnection()) {
            c.setAutoCommit(false);
            try {
                InvitationRow invitation = getInvitationForUpdate(c, normalizedToken);
                if (invitation == null) {
                    throw new io.javalin.http.NotFoundResponse("Invitation not found");
                }
                if (invitation.acceptedAt != null) {
                    throw new io.javalin.http.BadRequestResponse("Invitation already accepted");
                }
                if (invitation.expiresAt.isBefore(Instant.now())) {
                    throw new io.javalin.http.BadRequestResponse("Invitation expired");
                }

                String userEmail = getUserEmail(c, userId);
                if (!invitation.email.equalsIgnoreCase(userEmail)) {
                    throw new io.javalin.http.ForbiddenResponse("Sign in using the invited email address to accept this invitation");
                }

                if (invitation.organizationId != null) {
                    String workspaceRole = WORKSPACE_ROLES.contains(invitation.role) ? invitation.role : "member";
                    upsertOrganizationMember(c, invitation.organizationId, userId, workspaceRole);
                }
                if (invitation.projectId != null) {
                    String projectRole = normalizeProjectRole(invitation.role);
                    upsertProjectMember(c, invitation.projectId, userId, projectRole);
                }

                markInvitationAccepted(c, invitation.id);
                c.commit();

                Map<String, Object> out = new HashMap<>();
                out.put("accepted", true);
                out.put("organizationId", invitation.organizationId != null ? invitation.organizationId.toString() : null);
                out.put("projectId", invitation.projectId != null ? invitation.projectId.toString() : null);
                return out;
            } catch (RuntimeException e) {
                c.rollback();
                throw e;
            } catch (SQLException e) {
                c.rollback();
                throw new RuntimeException(e);
            } finally {
                c.setAutoCommit(true);
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static void sendWorkspaceInvitationEmail(String email, String organizationName, String token) {
        String link = Config.FRONTEND_URL + "/invite/" + token;
        String subject = "You are invited to join " + organizationName + " on TesboX";
        String body = "You have been invited to join the workspace \"" + organizationName + "\" on TesboX.\n\n"
                + "Open this secure invite link to join:\n"
                + link + "\n\n"
                + "This invitation expires in " + INVITATION_EXPIRY_HOURS + " hours.";
        EMAIL_SERVICE.sendEmail(email, subject, body);
    }

    private static PendingInvitation findPendingWorkspaceInvitation(UUID orgId, String email) {
        String sql = "SELECT id, token, expires_at, created_at FROM invitations " +
                "WHERE organization_id = ? AND project_id IS NULL AND email = ? AND accepted_at IS NULL AND expires_at > now() " +
                "ORDER BY created_at DESC LIMIT 1";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, orgId);
            ps.setString(2, email);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) return null;
            return new PendingInvitation(
                    (UUID) rs.getObject("id"),
                    rs.getString("token"),
                    rs.getTimestamp("expires_at").toInstant(),
                    rs.getTimestamp("created_at").toInstant()
            );
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static PendingInvitation insertWorkspaceInvitation(UUID orgId, String email, String role) {
        String token = generateToken();
        Instant expiresAt = Instant.now().plusSeconds(3600L * INVITATION_EXPIRY_HOURS);
        String sql = "INSERT INTO invitations (organization_id, project_id, email, role, token, expires_at) VALUES (?, NULL, ?, ?, ?, ?) " +
                "RETURNING id, created_at";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, orgId);
            ps.setString(2, email);
            ps.setString(3, role);
            ps.setString(4, token);
            ps.setTimestamp(5, Timestamp.from(expiresAt));
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) throw new RuntimeException("Failed to create invitation");
            return new PendingInvitation(
                    (UUID) rs.getObject("id"),
                    token,
                    expiresAt,
                    rs.getTimestamp("created_at").toInstant()
            );
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static Map<String, Object> toInvitationResponse(ResultSet rs) throws SQLException {
        Instant expiresAt = rs.getTimestamp("expires_at").toInstant();
        Timestamp acceptedTs = rs.getTimestamp("accepted_at");
        String status = acceptedTs != null ? "accepted" : (expiresAt.isBefore(Instant.now()) ? "expired" : "pending");

        Map<String, Object> out = new HashMap<>();
        out.put("id", rs.getObject("id").toString());
        out.put("organizationId", rs.getObject("organization_id") != null ? rs.getObject("organization_id").toString() : null);
        out.put("projectId", rs.getObject("project_id") != null ? rs.getObject("project_id").toString() : null);
        out.put("organizationName", rs.getString("organization_name"));
        out.put("projectName", rs.getString("project_name"));
        out.put("email", rs.getString("email"));
        out.put("role", rs.getString("role"));
        out.put("expiresAt", expiresAt.toString());
        out.put("acceptedAt", acceptedTs != null ? acceptedTs.toInstant().toString() : null);
        out.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
        out.put("status", status);
        return out;
    }

    private static InvitationRow getInvitationForUpdate(Connection c, String token) throws SQLException {
        String sql = "SELECT id, organization_id, project_id, email, role, expires_at, accepted_at " +
                "FROM invitations WHERE token = ? FOR UPDATE";
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, token);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) return null;
            return new InvitationRow(
                    (UUID) rs.getObject("id"),
                    (UUID) rs.getObject("organization_id"),
                    (UUID) rs.getObject("project_id"),
                    rs.getString("email"),
                    rs.getString("role"),
                    rs.getTimestamp("expires_at").toInstant(),
                    rs.getTimestamp("accepted_at")
            );
        }
    }

    private static String getUserEmail(Connection c, UUID userId) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement("SELECT email FROM users WHERE id = ?")) {
            ps.setObject(1, userId);
            ResultSet rs = ps.executeQuery();
            if (!rs.next()) throw new io.javalin.http.UnauthorizedResponse("User not found");
            return rs.getString("email");
        }
    }

    private static void upsertOrganizationMember(Connection c, UUID orgId, UUID userId, String role) throws SQLException {
        String sql = "INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?) " +
                "ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role";
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, orgId);
            ps.setObject(2, userId);
            ps.setString(3, role);
            ps.executeUpdate();
        }
    }

    private static void upsertProjectMember(Connection c, UUID projectId, UUID userId, String role) throws SQLException {
        String sql = "INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?) " +
                "ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role";
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ps.setObject(2, userId);
            ps.setString(3, role);
            ps.executeUpdate();
        }
    }

    private static void markInvitationAccepted(Connection c, UUID invitationId) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement("UPDATE invitations SET accepted_at = now() WHERE id = ?")) {
            ps.setObject(1, invitationId);
            ps.executeUpdate();
        }
    }

    private static String getOrganizationName(UUID orgId) {
        String sql = "SELECT name FROM organizations WHERE id = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, orgId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) return rs.getString("name");
            throw new io.javalin.http.NotFoundResponse("Workspace not found");
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static String normalizeEmail(String email) {
        if (email == null || (email = email.trim().toLowerCase()).isEmpty()) {
            throw new io.javalin.http.BadRequestResponse("Valid email is required");
        }
        return email;
    }

    private static String normalizeWorkspaceRole(String role) {
        String normalized = role == null ? "member" : role.trim().toLowerCase();
        if (normalized.isEmpty()) normalized = "member";
        if (!WORKSPACE_ROLES.contains(normalized)) {
            throw new io.javalin.http.BadRequestResponse("Invalid workspace role");
        }
        return normalized;
    }

    private static String normalizeProjectRole(String role) {
        String normalized = role == null ? "member" : role.trim().toLowerCase().replace("-", "_").replace(" ", "_");
        if ("project_admin".equals(normalized)) normalized = "admin";
        if ("test_manager".equals(normalized)) normalized = "manager";
        if ("qa_member".equals(normalized)) normalized = "member";
        if ("viewer".equals(normalized)) normalized = "member";
        if (!PROJECT_ROLES.contains(normalized)) {
            return "member";
        }
        return normalized;
    }

    private static String normalizeToken(String token) {
        if (token == null || (token = token.trim()).isEmpty()) {
            throw new io.javalin.http.BadRequestResponse("Invitation token required");
        }
        return token;
    }

    private static String generateToken() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
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

    private record PendingInvitation(UUID id, String token, Instant expiresAt, Instant createdAt) {}

    private record InvitationRow(UUID id, UUID organizationId, UUID projectId, String email, String role, Instant expiresAt, Timestamp acceptedAt) {}
}
