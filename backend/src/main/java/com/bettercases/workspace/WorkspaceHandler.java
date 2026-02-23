package com.bettercases.workspace;

import com.bettercases.auth.SessionFilter;
import io.javalin.http.Context;

import java.util.Map;
import java.util.UUID;

public final class WorkspaceHandler {

    public static void get(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        ctx.json(WorkspaceService.getCurrentUserWorkspace(userId)
                .orElseThrow(() -> new io.javalin.http.NotFoundResponse("No workspace found. Complete onboarding first.")));
    }

    public static void listMembers(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID orgId = WorkspaceService.getCurrentUserOrganizationId(userId)
                .orElseThrow(() -> new io.javalin.http.NotFoundResponse("No workspace found."));
        ctx.json(WorkspaceService.listWorkspaceMembers(orgId, userId));
    }

    public static void addMember(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID orgId = WorkspaceService.getCurrentUserOrganizationId(userId)
                .orElseThrow(() -> new io.javalin.http.NotFoundResponse("No workspace found."));
        AddMemberBody body = ctx.bodyAsClass(AddMemberBody.class);
        if (body == null) {
            ctx.status(400).json(Map.of("error", "Request body required"));
            return;
        }
        if (body.email != null && !body.email.isBlank()) {
            WorkspaceService.addWorkspaceMemberByEmail(orgId, userId, body.email.trim(), body.role != null ? body.role : "member");
        } else if (body.userId != null && !body.userId.isBlank()) {
            WorkspaceService.addWorkspaceMember(orgId, userId, UUID.fromString(body.userId), body.role != null ? body.role : "member");
        } else {
            ctx.status(400).json(Map.of("error", "email or userId required"));
            return;
        }
        ctx.status(204);
    }

    public static void removeMember(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID orgId = WorkspaceService.getCurrentUserOrganizationId(userId)
                .orElseThrow(() -> new io.javalin.http.NotFoundResponse("No workspace found."));
        String targetUserIdParam = ctx.pathParam("userId");
        WorkspaceService.removeWorkspaceMember(orgId, userId, UUID.fromString(targetUserIdParam));
        ctx.status(204);
    }

    public static void getProjectAccess(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID orgId = WorkspaceService.getCurrentUserOrganizationId(userId)
                .orElseThrow(() -> new io.javalin.http.NotFoundResponse("No workspace found."));
        ctx.json(WorkspaceService.listWorkspaceProjectAccess(orgId, userId));
    }

    public static void upsertProjectAccess(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID orgId = WorkspaceService.getCurrentUserOrganizationId(userId)
                .orElseThrow(() -> new io.javalin.http.NotFoundResponse("No workspace found."));
        ProjectAccessBody body = ctx.bodyAsClass(ProjectAccessBody.class);
        if (body == null || body.projectId == null || body.userId == null || body.role == null) {
            ctx.status(400).json(Map.of("error", "projectId, userId and role are required"));
            return;
        }
        WorkspaceService.setWorkspaceProjectAccess(
                orgId,
                userId,
                UUID.fromString(body.projectId),
                UUID.fromString(body.userId),
                body.role
        );
        ctx.status(204);
    }

    public static void removeProjectAccess(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID orgId = WorkspaceService.getCurrentUserOrganizationId(userId)
                .orElseThrow(() -> new io.javalin.http.NotFoundResponse("No workspace found."));
        ProjectAccessBody body = ctx.bodyAsClass(ProjectAccessBody.class);
        if (body == null || body.projectId == null || body.userId == null) {
            ctx.status(400).json(Map.of("error", "projectId and userId are required"));
            return;
        }
        WorkspaceService.removeWorkspaceProjectAccess(
                orgId,
                userId,
                UUID.fromString(body.projectId),
                UUID.fromString(body.userId)
        );
        ctx.status(204);
    }

    public static class AddMemberBody {
        public String email;
        public String userId;
        public String role;
    }

    public static class ProjectAccessBody {
        public String projectId;
        public String userId;
        public String role;
    }
}
