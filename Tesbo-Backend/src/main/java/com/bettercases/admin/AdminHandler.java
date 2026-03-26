package com.bettercases.admin;

import io.javalin.http.Context;

import java.util.Map;
import java.util.UUID;

public final class AdminHandler {

    public static void listAdmins(Context ctx) {
        SuperAdminService.requirePlatformAdmin(ctx);
        ctx.json(SuperAdminService.listAdmins());
    }

    public static void addAdmin(Context ctx) {
        UUID ownerId = SuperAdminService.requirePlatformOwner(ctx);

        record AddRequest(String email) {}
        AddRequest req = ctx.bodyAsClass(AddRequest.class);
        if (req.email() == null || req.email().isBlank()) {
            ctx.status(400).json(Map.of("error", "email is required"));
            return;
        }

        Map<String, Object> result = SuperAdminService.addAdmin(req.email(), ownerId);
        if (result == null) {
            ctx.status(404).json(Map.of("error", "User not found or already an admin"));
            return;
        }
        ctx.status(201).json(result);
    }

    public static void removeAdmin(Context ctx) {
        SuperAdminService.requirePlatformOwner(ctx);

        UUID adminId = UUID.fromString(ctx.pathParam("adminId"));
        boolean removed = SuperAdminService.removeAdmin(adminId);
        if (!removed) {
            ctx.status(400).json(Map.of("error", "Cannot remove this admin (owner or not found)"));
            return;
        }
        ctx.status(204);
    }

    private AdminHandler() {}
}
