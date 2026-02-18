package com.bettercases.testcase;

import com.bettercases.audit.AuditService;
import com.bettercases.auth.SessionFilter;
import io.javalin.http.Context;

import java.util.Map;
import java.util.UUID;

public final class TestCaseHandler {
    public static void list(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        int limit = Math.min(100, Math.max(1, ctx.queryParamAsClass("limit", Integer.class).getOrDefault(20)));
        int offset = Math.max(0, ctx.queryParamAsClass("offset", Integer.class).getOrDefault(0));
        String suiteId = ctx.queryParam("suiteId");
        String status = ctx.queryParam("status");
        String priority = ctx.queryParam("priority");
        String type = ctx.queryParam("type");
        String automationStatus = ctx.queryParam("automationStatus");
        String search = ctx.queryParam("search");
        var list = TestCaseService.list(projectId, userId, limit, offset, suiteId, status, priority, type, automationStatus, search);
        long total = TestCaseService.count(projectId, userId, suiteId, status, priority, type, automationStatus, search);
        ctx.header("X-Total-Count", String.valueOf(total));
        ctx.json(list);
    }

    public static void get(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID testcaseId = UUID.fromString(ctx.pathParam("testcaseId"));
        ctx.json(TestCaseService.get(testcaseId, userId)
                .orElseThrow(() -> new io.javalin.http.NotFoundResponse()));
    }

    public static void create(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        TestCaseService.CreateDto dto = ctx.bodyAsClass(TestCaseService.CreateDto.class);
        if (dto == null) dto = new TestCaseService.CreateDto();
        Map<String, Object> result = TestCaseService.create(projectId, userId, dto);
        try {
            AuditService.logActivity(userId, projectId, "created", "testcase",
                    String.valueOf(result.get("id")),
                    String.valueOf(result.get("title")));
        } catch (Exception ignored) {}
        ctx.status(201).json(result);
    }

    public static void update(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID testcaseId = UUID.fromString(ctx.pathParam("testcaseId"));
        TestCaseService.UpdateDto dto = ctx.bodyAsClass(TestCaseService.UpdateDto.class);
        if (dto == null) {
            ctx.status(400).json(Map.of("error", "body required"));
            return;
        }
        String title = dto.title != null ? dto.title : "";
        TestCaseService.update(testcaseId, userId, dto);
        try {
            AuditService.logActivity(userId, projectId, "updated", "testcase",
                    testcaseId.toString(), title);
        } catch (Exception ignored) {}
        ctx.status(204);
    }

    public static void delete(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID testcaseId = UUID.fromString(ctx.pathParam("testcaseId"));
        TestCaseService.delete(testcaseId, userId);
        try {
            AuditService.logActivity(userId, projectId, "deleted", "testcase",
                    testcaseId.toString(), null);
        } catch (Exception ignored) {}
        ctx.status(204);
    }

    public static void linkedJiraKeys(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        ctx.json(Map.of(
            "keys", TestCaseService.listLinkedJiraKeys(projectId, userId),
            "counts", TestCaseService.countByJiraKey(projectId, userId)
        ));
    }
}
