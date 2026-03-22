package com.bettercases.invitation;

import com.bettercases.auth.SessionFilter;
import com.bettercases.workspace.WorkspaceService;
import io.javalin.http.Context;

import java.util.Map;
import java.util.UUID;

public final class InvitationHandler {
    private InvitationHandler() {}

    public static void createWorkspaceInvitation(Context ctx) {
        UUID actorId = SessionFilter.requireUserId(ctx);
        UUID orgId = WorkspaceService.getCurrentUserOrganizationId(actorId)
                .orElseThrow(() -> new io.javalin.http.NotFoundResponse("No workspace found."));
        CreateInvitationBody body = ctx.bodyAsClass(CreateInvitationBody.class);
        if (body == null || body.email == null || body.email.isBlank()) {
            ctx.status(400).json(Map.of("error", "email is required"));
            return;
        }
        Map<String, Object> created = InvitationService.createWorkspaceInvitation(
                orgId,
                actorId,
                body.email,
                body.role
        );
        ctx.status(201).json(created);
    }

    public static void listWorkspaceInvitations(Context ctx) {
        UUID actorId = SessionFilter.requireUserId(ctx);
        UUID orgId = WorkspaceService.getCurrentUserOrganizationId(actorId)
                .orElseThrow(() -> new io.javalin.http.NotFoundResponse("No workspace found."));
        ctx.json(InvitationService.listPendingWorkspaceInvitations(orgId, actorId));
    }

    public static void revokeWorkspaceInvitation(Context ctx) {
        UUID actorId = SessionFilter.requireUserId(ctx);
        UUID orgId = WorkspaceService.getCurrentUserOrganizationId(actorId)
                .orElseThrow(() -> new io.javalin.http.NotFoundResponse("No workspace found."));
        UUID invitationId = UUID.fromString(ctx.pathParam("id"));
        InvitationService.revokeWorkspaceInvitation(orgId, actorId, invitationId);
        ctx.status(204);
    }

    public static void getByToken(Context ctx) {
        String token = ctx.pathParam("token");
        ctx.json(InvitationService.getInvitationByToken(token));
    }

    public static void acceptByToken(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        String token = ctx.pathParam("token");
        ctx.json(InvitationService.acceptInvitation(token, userId));
    }

    public static class CreateInvitationBody {
        public String email;
        public String role;
    }
}
