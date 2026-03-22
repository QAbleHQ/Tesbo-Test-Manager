package com.bettercases.jira;

import com.bettercases.audit.AuditService;
import com.bettercases.auth.SessionFilter;
import io.javalin.http.Context;

import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class JiraHandler {

    /** GET /api/projects/{projectId}/jira/auth-url — returns the Atlassian OAuth URL the frontend should redirect to. */
    public static void authUrl(Context ctx) {
        SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        String url = JiraService.buildAuthorizeUrl(projectId);
        ctx.json(Map.of("url", url));
    }

    /** POST /api/projects/{projectId}/jira/callback — exchange the authorization code for tokens and save connection. */
    public static void callback(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        CallbackBody body = ctx.bodyAsClass(CallbackBody.class);
        if (body == null || body.code == null || body.code.isBlank()) {
            ctx.status(400).json(Map.of("error", "code is required"));
            return;
        }
        try {
            Map<String, Object> result = JiraService.exchangeCodeAndSave(body.code, projectId, userId);
            try {
                AuditService.logActivity(userId, projectId, "connected", "jira", projectId.toString(), "Jira connected");
            } catch (Exception ignored) {}
            ctx.json(result);
        } catch (Exception e) {
            System.err.println("[JIRA] callback failed: " + e.getMessage());
            e.printStackTrace(System.err);
            ctx.status(500).json(Map.of("error", "Jira authentication failed: " + e.getMessage()));
        }
    }

    /** GET /api/projects/{projectId}/jira/status — returns connection status. */
    public static void status(Context ctx) {
        SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        try {
            var conn = JiraService.getConnection(projectId);
            if (conn.isPresent()) {
                Map<String, Object> result = new java.util.LinkedHashMap<>(conn.get());
                result.put("connected", true);
                result.put("connectedProjects", JiraService.getConnectedProjects(projectId));
                ctx.json(result);
            } else {
                ctx.json(Map.of("connected", false));
            }
        } catch (Exception e) {
            System.err.println("[JIRA] status failed: " + e.getMessage());
            e.printStackTrace(System.err);
            ctx.status(500).json(Map.of("error", e.getMessage()));
        }
    }

    /** DELETE /api/projects/{projectId}/jira/disconnect — remove the Jira connection. */
    public static void disconnect(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        try {
            JiraService.disconnect(projectId);
            try {
                AuditService.logActivity(userId, projectId, "disconnected", "jira", projectId.toString(), "Jira disconnected");
            } catch (Exception ignored) {}
            ctx.status(204);
        } catch (Exception e) {
            System.err.println("[JIRA] disconnect failed: " + e.getMessage());
            e.printStackTrace(System.err);
            ctx.status(500).json(Map.of("error", e.getMessage()));
        }
    }

    /** GET /api/projects/{projectId}/jira/projects — lists Jira projects available in the connected site. */
    public static void listJiraProjects(Context ctx) {
        SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        try {
            ctx.json(JiraService.listJiraProjects(projectId));
        } catch (Exception e) {
            System.err.println("[JIRA] listJiraProjects failed: " + e.getMessage());
            e.printStackTrace(System.err);
            ctx.status(500).json(Map.of("error", e.getMessage()));
        }
    }

    /** POST /api/projects/{projectId}/jira/projects — connect selected Jira projects. */
    public static void connectProjects(Context ctx) {
        SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        ConnectBody body = ctx.bodyAsClass(ConnectBody.class);
        if (body == null || body.projects == null || body.projects.isEmpty()) {
            ctx.status(400).json(Map.of("error", "projects array is required"));
            return;
        }
        try {
            JiraService.connectJiraProjects(projectId, body.projects);
            ctx.status(204);
        } catch (Exception e) {
            System.err.println("[JIRA] connectProjects failed: " + e.getMessage());
            e.printStackTrace(System.err);
            ctx.status(500).json(Map.of("error", e.getMessage()));
        }
    }

    /** POST /api/projects/{projectId}/jira/sync — trigger a ticket sync from connected Jira projects. */
    public static void sync(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        try {
            int count = JiraService.syncTickets(projectId);
            try {
                AuditService.logActivity(userId, projectId, "synced", "jira",
                        projectId.toString(), count + " tickets synced");
            } catch (Exception ignored) {}
            ctx.json(Map.of("synced", count));
        } catch (Exception e) {
            System.err.println("[JIRA] sync failed: " + e.getMessage());
            e.printStackTrace(System.err);
            ctx.status(500).json(Map.of("error", e.getMessage()));
        }
    }

    /** GET /api/projects/{projectId}/jira/tickets — list cached Jira tickets for the knowledge base. */
    public static void listTickets(Context ctx) {
        SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        int limit = ctx.queryParamAsClass("limit", Integer.class).getOrDefault(50);
        int offset = ctx.queryParamAsClass("offset", Integer.class).getOrDefault(0);
        String search = ctx.queryParam("search");
        try {
            ctx.json(JiraService.listTickets(projectId, limit, offset, search));
        } catch (Exception e) {
            System.err.println("[JIRA] listTickets failed: " + e.getMessage());
            e.printStackTrace(System.err);
            ctx.status(500).json(Map.of("error", e.getMessage()));
        }
    }

    /** POST /api/projects/{projectId}/jira/comment — add a comment to a Jira issue. */
    public static void addComment(Context ctx) {
        SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        CommentBody body = ctx.bodyAsClass(CommentBody.class);
        if (body == null || body.issueKey == null || body.issueKey.isBlank() || body.comment == null || body.comment.isBlank()) {
            ctx.status(400).json(Map.of("error", "issueKey and comment are required"));
            return;
        }
        try {
            JiraService.addComment(projectId, body.issueKey, body.comment, body.testCases);
            ctx.status(204);
        } catch (Exception e) {
            System.err.println("[JIRA] addComment failed: " + e.getMessage());
            e.printStackTrace(System.err);
            ctx.status(500).json(Map.of("error", e.getMessage()));
        }
    }

    // ---- Request body classes ----

    public static class CallbackBody {
        public String code;
    }

    public static class ConnectBody {
        public List<Map<String, String>> projects;
    }

    public static class CommentBody {
        public String issueKey;
        public String comment;
        public List<TestCaseLink> testCases;
    }

    public static class TestCaseLink {
        public String id;
        public String title;
    }
}
