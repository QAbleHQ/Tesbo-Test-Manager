package com.bettercases.notifications;

import com.bettercases.auth.SessionFilter;
import io.javalin.http.Context;

import java.util.UUID;

public final class NotificationHandler {
    public static void list(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        int limit = Math.min(50, Math.max(1, ctx.queryParamAsClass("limit", Integer.class).getOrDefault(20)));
        boolean unreadOnly = Boolean.parseBoolean(ctx.queryParam("unreadOnly"));
        ctx.json(NotificationService.listForUser(userId, limit, unreadOnly));
    }

    public static void markRead(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID notificationId = UUID.fromString(ctx.pathParam("id"));
        NotificationService.markRead(notificationId, userId);
        ctx.status(204);
    }
}
