package com.bettercases.plan;

import com.bettercases.audit.AuditService;
import com.bettercases.auth.SessionFilter;
import io.javalin.http.Context;

import java.util.Map;
import java.util.UUID;

public final class PlanHandler {
    public static void list(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        ctx.json(PlanService.list(projectId, userId));
    }

    public static void get(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID planId = UUID.fromString(ctx.pathParam("planId"));
        ctx.json(PlanService.get(planId, userId).orElseThrow(() -> new io.javalin.http.NotFoundResponse()));
    }

    public static void create(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        CreateBody body = ctx.bodyAsClass(CreateBody.class);
        String name = body != null && body.name != null ? body.name : "New plan";
        String desc = body != null ? body.description : null;
        String release = body != null ? body.targetRelease : null;
        Map<String, Object> result = PlanService.create(projectId, userId, name, desc, release);
        try {
            AuditService.logActivity(userId, projectId, "created", "plan",
                    String.valueOf(result.get("id")), name);
        } catch (Exception ignored) {}
        ctx.status(201).json(result);
    }

    public static void update(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID planId = UUID.fromString(ctx.pathParam("planId"));
        UpdateBody body = ctx.bodyAsClass(UpdateBody.class);
        if (body == null) body = new UpdateBody();
        PlanService.update(planId, userId, body.name, body.description, body.targetRelease);
        try {
            UUID projectId = PlanService.getProjectIdForPlan(planId);
            if (projectId != null) {
                AuditService.logActivity(userId, projectId, "updated", "plan",
                        planId.toString(), body.name);
            }
        } catch (Exception ignored) {}
        ctx.status(204);
    }

    public static void delete(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID planId = UUID.fromString(ctx.pathParam("planId"));
        UUID projectId = null;
        try {
            projectId = PlanService.getProjectIdForPlan(planId);
        } catch (Exception ignored) {}
        PlanService.delete(planId, userId);
        try {
            if (projectId != null) {
                AuditService.logActivity(userId, projectId, "deleted", "plan",
                        planId.toString(), null);
            }
        } catch (Exception ignored) {}
        ctx.status(204);
    }

    public static void listItems(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID planId = UUID.fromString(ctx.pathParam("planId"));
        ctx.json(PlanService.listItems(planId, userId));
    }

    public static void addItem(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID planId = UUID.fromString(ctx.pathParam("planId"));
        AddItemBody body = ctx.bodyAsClass(AddItemBody.class);
        if (body == null) {
            ctx.status(400);
            return;
        }
        UUID suiteId = body.suiteId != null ? UUID.fromString(body.suiteId) : null;
        UUID testcaseId = body.testcaseId != null ? UUID.fromString(body.testcaseId) : null;
        int position = body.position != null ? body.position : 0;
        PlanService.addItem(planId, userId, suiteId, testcaseId, position);
        ctx.status(204);
    }

    public static void removeItem(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID planId = UUID.fromString(ctx.pathParam("planId"));
        UUID itemId = UUID.fromString(ctx.pathParam("itemId"));
        PlanService.removeItem(planId, userId, itemId);
        ctx.status(204);
    }

    public static void listRuns(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID planId = UUID.fromString(ctx.pathParam("planId"));
        ctx.json(PlanService.listRuns(planId, userId));
    }

    public static void getProgress(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID planId = UUID.fromString(ctx.pathParam("planId"));
        ctx.json(PlanService.getProgress(planId, userId));
    }

    public static class CreateBody {
        public String name;
        public String description;
        public String targetRelease;
    }

    public static class UpdateBody {
        public String name;
        public String description;
        public String targetRelease;
    }

    public static class AddItemBody {
        public String suiteId;
        public String testcaseId;
        public Integer position;
    }
}
