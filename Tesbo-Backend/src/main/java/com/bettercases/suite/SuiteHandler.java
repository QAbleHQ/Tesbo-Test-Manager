package com.bettercases.suite;

import com.bettercases.audit.AuditService;
import com.bettercases.auth.SessionFilter;
import io.javalin.http.Context;

import java.util.Map;
import java.util.UUID;

public final class SuiteHandler {
    public static void listTree(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        ctx.json(SuiteService.listTree(projectId, userId));
    }

    public static void create(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        CreateBody body = ctx.bodyAsClass(CreateBody.class);
        if (body != null && body.parentId != null) {
            throw new io.javalin.http.BadRequestResponse("Subsuites are not supported");
        }
        String name = body != null && body.name != null ? body.name : "New suite";
        int position = body != null && body.position != null ? body.position : 0;
        Map<String, Object> result = SuiteService.create(projectId, userId, name, null, position);
        try {
            AuditService.logActivity(userId, projectId, "created", "suite",
                    String.valueOf(result.get("id")), name);
        } catch (Exception ignored) {}
        ctx.json(result);
    }

    public static void update(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID suiteId = UUID.fromString(ctx.pathParam("suiteId"));
        UpdateBody body = ctx.bodyAsClass(UpdateBody.class);
        if (body == null) body = new UpdateBody();
        if (body.parentId != null) {
            throw new io.javalin.http.BadRequestResponse("Subsuites are not supported");
        }
        SuiteService.update(suiteId, userId, body.name, null, body.position);
        try {
            UUID projectId = SuiteService.getProjectIdForSuite(suiteId);
            if (projectId != null) {
                AuditService.logActivity(userId, projectId, "updated", "suite",
                        suiteId.toString(), body.name);
            }
        } catch (Exception ignored) {}
        ctx.status(204);
    }

    public static void delete(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID suiteId = UUID.fromString(ctx.pathParam("suiteId"));
        String mode = ctx.queryParam("mode");
        if (mode == null || mode.isBlank()) mode = "moveToDefault";
        UUID projectId = null;
        try {
            projectId = SuiteService.getProjectIdForSuite(suiteId);
        } catch (Exception ignored) {}
        SuiteService.delete(suiteId, userId, mode);
        try {
            if (projectId != null) {
                AuditService.logActivity(userId, projectId, "deleted", "suite",
                        suiteId.toString(), null);
            }
        } catch (Exception ignored) {}
        ctx.status(204);
    }

    public static class CreateBody {
        public String name;
        public String parentId;
        public Integer position;
    }

    public static class UpdateBody {
        public String name;
        public String parentId;
        public Integer position;
    }
}
