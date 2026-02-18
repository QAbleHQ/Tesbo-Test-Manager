package com.bettercases.project;

import com.bettercases.auth.SessionFilter;
import com.bettercases.workspace.WorkspaceService;
import io.javalin.http.Context;

import java.util.Map;
import java.util.UUID;

public final class ProjectHandler {
    public static void list(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        ctx.json(ProjectService.listProjectsForUser(userId));
    }

    public static void create(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID orgId = WorkspaceService.getCurrentUserOrganizationId(userId)
                .orElseThrow(() -> new io.javalin.http.BadRequestResponse("No workspace found. Complete onboarding first."));
        CreateBody body = ctx.bodyAsClass(CreateBody.class);
        if (body == null || body.name == null || body.name.isBlank()) {
            ctx.status(400).json(Map.of("error", "name is required"));
            return;
        }
        String key = body.key != null && !body.key.isBlank() ? body.key : body.name;
        ctx.status(201).json(ProjectService.create(orgId, userId, key, body.name, body.description));
    }

    public static void get(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("id"));
        ctx.json(ProjectService.getProject(projectId, userId)
                .orElseThrow(() -> new io.javalin.http.NotFoundResponse()));
    }

    public static void update(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("id"));
        UpdateBody body = ctx.bodyAsClass(UpdateBody.class);
        if (body == null) body = new UpdateBody();
        ProjectService.updateProject(projectId, userId, body.name, body.description, body.settings);
        ctx.status(204);
    }

    public static void listMembers(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("id"));
        ctx.json(ProjectService.listMembers(projectId, userId));
    }

    public static void addMember(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("id"));
        AddMemberBody body = ctx.bodyAsClass(AddMemberBody.class);
        if (body == null || body.userId == null || body.role == null) {
            ctx.status(400).json(Map.of("error", "userId and role required"));
            return;
        }
        ProjectService.addMember(projectId, userId, UUID.fromString(body.userId), body.role);
        ctx.status(204);
    }

    public static void removeMember(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("id"));
        String targetUserId = ctx.pathParam("userId");
        ProjectService.removeMember(projectId, userId, UUID.fromString(targetUserId));
        ctx.status(204);
    }

    public static class CreateBody {
        public String key;
        public String name;
        public String description;
    }

    public static class UpdateBody {
        public String name;
        public String description;
        public String settings;
    }

    public static class AddMemberBody {
        public String userId;
        public String role;
    }
}
