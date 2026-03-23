package com.bettercases.testcase;

import com.bettercases.audit.AuditService;
import com.bettercases.auth.SessionFilter;
import io.javalin.http.Context;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

public final class BulkUpdateHandler {
    public static void bulkUpdate(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        BulkUpdateBody body = ctx.bodyAsClass(BulkUpdateBody.class);
        if (body == null || body.testcaseIds == null || body.testcaseIds.isEmpty()) {
            ctx.status(400).json(Map.of("error", "testcaseIds required"));
            return;
        }
        List<UUID> ids = body.testcaseIds.stream().map(UUID::fromString).collect(Collectors.toList());
        TestCaseService.bulkUpdate(projectId, userId, ids, body.priority, body.suiteId, body.status, body.ownerId);
        try {
            AuditService.logActivity(userId, projectId, "bulk_updated", "testcase",
                    ids.size() + " test cases", null);
        } catch (Exception ignored) {}
        ctx.status(204);
    }

    public static void bulkDelete(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        BulkDeleteBody body = ctx.bodyAsClass(BulkDeleteBody.class);
        if (body == null || body.testcaseIds == null || body.testcaseIds.isEmpty()) {
            ctx.status(400).json(Map.of("error", "testcaseIds required"));
            return;
        }
        List<UUID> ids = body.testcaseIds.stream().map(UUID::fromString).collect(Collectors.toList());
        TestCaseService.bulkDelete(projectId, userId, ids);
        try {
            AuditService.logActivity(userId, projectId, "bulk_deleted", "testcase",
                    ids.size() + " test cases", null);
        } catch (Exception ignored) {}
        ctx.status(204);
    }

    public static class BulkUpdateBody {
        public List<String> testcaseIds;
        public String priority;
        public String suiteId;
        public String status;
        public String ownerId;
    }

    public static class BulkDeleteBody {
        public List<String> testcaseIds;
    }
}
