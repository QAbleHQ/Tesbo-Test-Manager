package com.bettercases.bug;

import com.bettercases.auth.SessionFilter;
import io.javalin.http.Context;

import java.util.Map;
import java.util.UUID;

public final class BugHandler {

    /* ───── LIST bugs for a project ───── */
    public static void list(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        String status = ctx.queryParam("status");
        String cycleIdStr = ctx.queryParam("cycleId");
        UUID cycleId = cycleIdStr != null && !cycleIdStr.isBlank() ? UUID.fromString(cycleIdStr) : null;
        ctx.json(BugService.list(projectId, userId, status, cycleId));
    }

    /* ───── GET single bug ───── */
    public static void get(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID bugId = UUID.fromString(ctx.pathParam("bugId"));
        ctx.json(BugService.get(bugId, userId).orElseThrow(() -> new io.javalin.http.NotFoundResponse()));
    }

    /* ───── CREATE ───── */
    public static void create(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        CreateBody body = ctx.bodyAsClass(CreateBody.class);
        if (body == null || body.title == null || body.title.isBlank()) {
            ctx.status(400).json(Map.of("error", "title is required"));
            return;
        }
        UUID executionId = body.executionId != null ? UUID.fromString(body.executionId) : null;
        UUID testcaseId = body.testcaseId != null ? UUID.fromString(body.testcaseId) : null;
        UUID cycleId = body.cycleId != null ? UUID.fromString(body.cycleId) : null;
        ctx.status(201).json(BugService.create(projectId, userId, body.title, body.description, body.externalUrl, executionId, testcaseId, cycleId));
    }

    /* ───── UPDATE ───── */
    public static void update(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID bugId = UUID.fromString(ctx.pathParam("bugId"));
        UpdateBody body = ctx.bodyAsClass(UpdateBody.class);
        if (body == null) body = new UpdateBody();
        BugService.update(bugId, userId, body.title, body.description, body.externalUrl, body.status);
        ctx.status(204);
    }

    /* ───── DELETE ───── */
    public static void delete(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID bugId = UUID.fromString(ctx.pathParam("bugId"));
        BugService.delete(bugId, userId);
        ctx.status(204);
    }

    /* ───── DTOs ───── */
    public static class CreateBody {
        public String title;
        public String description;
        public String externalUrl;
        public String executionId;
        public String testcaseId;
        public String cycleId;
    }

    public static class UpdateBody {
        public String title;
        public String description;
        public String externalUrl;
        public String status;
    }
}
