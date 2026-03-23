package com.bettercases.audit;

import com.bettercases.auth.SessionFilter;
import com.bettercases.rbac.RbacService;
import io.javalin.http.Context;

import java.util.Map;
import java.util.UUID;

public final class ActivityHandler {

    public static void list(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        RbacService.requireProjectRole(userId, projectId);

        int limit = Math.min(100, Math.max(1, ctx.queryParamAsClass("limit", Integer.class).getOrDefault(30)));
        int offset = Math.max(0, ctx.queryParamAsClass("offset", Integer.class).getOrDefault(0));
        String entityType = ctx.queryParam("entityType");

        var list = AuditService.listByProject(projectId, limit, offset, entityType);
        long total = AuditService.countByProject(projectId, entityType);

        ctx.header("X-Total-Count", String.valueOf(total));
        ctx.json(Map.of("list", list, "total", total));
    }
}
