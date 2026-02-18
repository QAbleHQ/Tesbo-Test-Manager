package com.bettercases.jira;

import com.bettercases.Config;
import com.bettercases.Database;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.*;

public final class JiraService {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final HttpClient HTTP = HttpClient.newHttpClient();

    private static final String AUTH_URL = "https://auth.atlassian.com/authorize";
    private static final String TOKEN_URL = "https://auth.atlassian.com/oauth/token";
    private static final String RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";
    private static final String JIRA_API_BASE = "https://api.atlassian.com/ex/jira/";

    // ---------- OAuth helpers ----------

    public static String buildAuthorizeUrl(UUID projectId) {
        String state = projectId.toString();
        return AUTH_URL
                + "?audience=api.atlassian.com"
                + "&client_id=" + enc(Config.JIRA_CLIENT_ID)
                + "&scope=" + enc("read:jira-work read:jira-user write:jira-work offline_access")
                + "&redirect_uri=" + enc(Config.JIRA_REDIRECT_URI)
                + "&state=" + enc(state)
                + "&response_type=code"
                + "&prompt=consent";
    }

    /** Exchange authorization code for access + refresh tokens, pick the first cloud site,
     *  and persist the connection. */
    public static Map<String, Object> exchangeCodeAndSave(String code, UUID projectId, UUID userId) throws Exception {
        // 1. Exchange code for tokens
        String tokenBody = MAPPER.writeValueAsString(Map.of(
                "grant_type", "authorization_code",
                "client_id", Config.JIRA_CLIENT_ID,
                "client_secret", Config.JIRA_CLIENT_SECRET,
                "code", code,
                "redirect_uri", Config.JIRA_REDIRECT_URI
        ));
        HttpRequest tokenReq = HttpRequest.newBuilder()
                .uri(URI.create(TOKEN_URL))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(tokenBody))
                .build();
        HttpResponse<String> tokenRes = HTTP.send(tokenReq, HttpResponse.BodyHandlers.ofString());
        if (tokenRes.statusCode() != 200) {
            throw new RuntimeException("Token exchange failed: " + tokenRes.body());
        }
        JsonNode tokenJson = MAPPER.readTree(tokenRes.body());
        String accessToken = tokenJson.get("access_token").asText();
        String refreshToken = tokenJson.has("refresh_token") ? tokenJson.get("refresh_token").asText() : "";
        int expiresIn = tokenJson.has("expires_in") ? tokenJson.get("expires_in").asInt() : 3600;

        // 2. Get accessible resources (cloud sites)
        HttpRequest resReq = HttpRequest.newBuilder()
                .uri(URI.create(RESOURCES_URL))
                .header("Authorization", "Bearer " + accessToken)
                .header("Accept", "application/json")
                .GET().build();
        HttpResponse<String> resRes = HTTP.send(resReq, HttpResponse.BodyHandlers.ofString());
        if (resRes.statusCode() != 200) {
            throw new RuntimeException("Failed to get accessible resources: " + resRes.body());
        }
        JsonNode sites = MAPPER.readTree(resRes.body());
        if (!sites.isArray() || sites.isEmpty()) {
            throw new RuntimeException("No Jira cloud sites found for this account.");
        }
        JsonNode site = sites.get(0);
        String cloudId = site.get("id").asText();
        String siteUrl = site.get("url").asText();

        // 3. Upsert jira_connections
        Timestamp expiresAt = Timestamp.from(Instant.now().plusSeconds(expiresIn));
        try (Connection c = Database.getDataSource().getConnection()) {
            String sql = """
                INSERT INTO jira_connections (project_id, cloud_id, site_url, access_token, refresh_token, token_expires_at, connected_by)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (project_id) DO UPDATE
                    SET cloud_id = EXCLUDED.cloud_id,
                        site_url = EXCLUDED.site_url,
                        access_token = EXCLUDED.access_token,
                        refresh_token = EXCLUDED.refresh_token,
                        token_expires_at = EXCLUDED.token_expires_at,
                        connected_by = EXCLUDED.connected_by,
                        updated_at = now()
                RETURNING id
                """;
            try (PreparedStatement ps = c.prepareStatement(sql)) {
                ps.setObject(1, projectId);
                ps.setString(2, cloudId);
                ps.setString(3, siteUrl);
                ps.setString(4, accessToken);
                ps.setString(5, refreshToken);
                ps.setTimestamp(6, expiresAt);
                ps.setObject(7, userId);
                try (ResultSet rs = ps.executeQuery()) {
                    rs.next();
                    String connectionId = rs.getString("id");
                    return Map.of(
                            "connectionId", connectionId,
                            "cloudId", cloudId,
                            "siteUrl", siteUrl
                    );
                }
            }
        }
    }

    // ---------- Connection status ----------

    public static Optional<Map<String, Object>> getConnection(UUID projectId) throws Exception {
        try (Connection c = Database.getDataSource().getConnection()) {
            String sql = "SELECT id, cloud_id, site_url, token_expires_at, connected_by, created_at FROM jira_connections WHERE project_id = ?";
            try (PreparedStatement ps = c.prepareStatement(sql)) {
                ps.setObject(1, projectId);
                try (ResultSet rs = ps.executeQuery()) {
                    if (!rs.next()) return Optional.empty();
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("id", rs.getString("id"));
                    row.put("cloudId", rs.getString("cloud_id"));
                    row.put("siteUrl", rs.getString("site_url"));
                    row.put("tokenExpiresAt", rs.getTimestamp("token_expires_at").toInstant().toString());
                    row.put("connectedBy", rs.getString("connected_by"));
                    row.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
                    return Optional.of(row);
                }
            }
        }
    }

    public static void disconnect(UUID projectId) throws Exception {
        try (Connection c = Database.getDataSource().getConnection()) {
            try (PreparedStatement ps = c.prepareStatement("DELETE FROM jira_connections WHERE project_id = ?")) {
                ps.setObject(1, projectId);
                ps.executeUpdate();
            }
        }
    }

    // ---------- Token refresh ----------

    private static String getValidAccessToken(UUID projectId) throws Exception {
        try (Connection c = Database.getDataSource().getConnection()) {
            String sql = "SELECT id, access_token, refresh_token, token_expires_at, cloud_id FROM jira_connections WHERE project_id = ?";
            try (PreparedStatement ps = c.prepareStatement(sql)) {
                ps.setObject(1, projectId);
                try (ResultSet rs = ps.executeQuery()) {
                    if (!rs.next()) throw new RuntimeException("No Jira connection for this project");
                    String accessToken = rs.getString("access_token");
                    String refreshTokenVal = rs.getString("refresh_token");
                    Timestamp expiresAt = rs.getTimestamp("token_expires_at");

                    if (expiresAt.toInstant().isAfter(Instant.now().plusSeconds(60))) {
                        return accessToken;
                    }

                    // Refresh the token
                    String body = MAPPER.writeValueAsString(Map.of(
                            "grant_type", "refresh_token",
                            "client_id", Config.JIRA_CLIENT_ID,
                            "client_secret", Config.JIRA_CLIENT_SECRET,
                            "refresh_token", refreshTokenVal
                    ));
                    HttpRequest req = HttpRequest.newBuilder()
                            .uri(URI.create(TOKEN_URL))
                            .header("Content-Type", "application/json")
                            .POST(HttpRequest.BodyPublishers.ofString(body))
                            .build();
                    HttpResponse<String> res = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
                    if (res.statusCode() != 200) {
                        // Refresh failed — remove the stale connection so user can re-authenticate
                        try (PreparedStatement del = c.prepareStatement("DELETE FROM jira_connections WHERE project_id = ?")) {
                            del.setObject(1, projectId);
                            del.executeUpdate();
                        }
                        throw new RuntimeException("Jira session expired. Please reconnect Jira from Project Settings.");
                    }
                    JsonNode json = MAPPER.readTree(res.body());
                    String newAccess = json.get("access_token").asText();
                    String newRefresh = json.has("refresh_token") ? json.get("refresh_token").asText() : refreshTokenVal;
                    int expiresIn = json.has("expires_in") ? json.get("expires_in").asInt() : 3600;

                    try (PreparedStatement up = c.prepareStatement(
                            "UPDATE jira_connections SET access_token = ?, refresh_token = ?, token_expires_at = ?, updated_at = now() WHERE project_id = ?")) {
                        up.setString(1, newAccess);
                        up.setString(2, newRefresh);
                        up.setTimestamp(3, Timestamp.from(Instant.now().plusSeconds(expiresIn)));
                        up.setObject(4, projectId);
                        up.executeUpdate();
                    }
                    return newAccess;
                }
            }
        }
    }

    private static String getCloudId(UUID projectId) throws Exception {
        try (Connection c = Database.getDataSource().getConnection()) {
            try (PreparedStatement ps = c.prepareStatement("SELECT cloud_id FROM jira_connections WHERE project_id = ?")) {
                ps.setObject(1, projectId);
                try (ResultSet rs = ps.executeQuery()) {
                    if (!rs.next()) throw new RuntimeException("No Jira connection");
                    return rs.getString("cloud_id");
                }
            }
        }
    }

    // ---------- Jira projects ----------

    public static List<Map<String, Object>> listJiraProjects(UUID projectId) throws Exception {
        String token = getValidAccessToken(projectId);
        String cloudId = getCloudId(projectId);
        String url = JIRA_API_BASE + cloudId + "/rest/api/3/project/search?maxResults=100";
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .header("Authorization", "Bearer " + token)
                .header("Accept", "application/json")
                .GET().build();
        HttpResponse<String> res = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() != 200) {
            throw new RuntimeException("Failed to list Jira projects: " + res.body());
        }
        JsonNode root = MAPPER.readTree(res.body());
        JsonNode values = root.get("values");
        List<Map<String, Object>> result = new ArrayList<>();
        if (values != null && values.isArray()) {
            for (JsonNode p : values) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("id", p.get("id").asText());
                m.put("key", p.get("key").asText());
                m.put("name", p.get("name").asText());
                m.put("style", p.has("style") ? p.get("style").asText() : "");
                result.add(m);
            }
        }

        // Mark which are already connected
        Set<String> connected = getConnectedJiraProjectIds(projectId);
        for (Map<String, Object> m : result) {
            m.put("connected", connected.contains(m.get("id").toString()));
        }
        return result;
    }

    private static Set<String> getConnectedJiraProjectIds(UUID projectId) throws Exception {
        Set<String> ids = new HashSet<>();
        try (Connection c = Database.getDataSource().getConnection()) {
            String sql = "SELECT jira_project_id FROM jira_project_mappings WHERE project_id = ? AND enabled = true";
            try (PreparedStatement ps = c.prepareStatement(sql)) {
                ps.setObject(1, projectId);
                try (ResultSet rs = ps.executeQuery()) {
                    while (rs.next()) ids.add(rs.getString("jira_project_id"));
                }
            }
        }
        return ids;
    }

    // ---------- Connect / disconnect Jira projects ----------

    public static void connectJiraProjects(UUID projectId, List<Map<String, String>> jiraProjects) throws Exception {
        try (Connection c = Database.getDataSource().getConnection()) {
            // Get connection id
            UUID connectionId;
            try (PreparedStatement ps = c.prepareStatement("SELECT id FROM jira_connections WHERE project_id = ?")) {
                ps.setObject(1, projectId);
                try (ResultSet rs = ps.executeQuery()) {
                    if (!rs.next()) throw new RuntimeException("No Jira connection");
                    connectionId = UUID.fromString(rs.getString("id"));
                }
            }

            // Remove existing mappings for this project
            try (PreparedStatement ps = c.prepareStatement("DELETE FROM jira_project_mappings WHERE project_id = ?")) {
                ps.setObject(1, projectId);
                ps.executeUpdate();
            }

            // Also remove tickets from previously-connected Jira projects
            try (PreparedStatement ps = c.prepareStatement("DELETE FROM jira_tickets WHERE project_id = ?")) {
                ps.setObject(1, projectId);
                ps.executeUpdate();
            }

            // Insert new mappings
            String sql = "INSERT INTO jira_project_mappings (jira_connection_id, project_id, jira_project_id, jira_project_key, jira_project_name) VALUES (?, ?, ?, ?, ?)";
            try (PreparedStatement ps = c.prepareStatement(sql)) {
                for (Map<String, String> jp : jiraProjects) {
                    ps.setObject(1, connectionId);
                    ps.setObject(2, projectId);
                    ps.setString(3, jp.get("id"));
                    ps.setString(4, jp.get("key"));
                    ps.setString(5, jp.get("name"));
                    ps.addBatch();
                }
                ps.executeBatch();
            }
        }
    }

    public static List<Map<String, Object>> getConnectedProjects(UUID projectId) throws Exception {
        List<Map<String, Object>> result = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection()) {
            String sql = "SELECT id, jira_project_id, jira_project_key, jira_project_name, created_at FROM jira_project_mappings WHERE project_id = ? AND enabled = true ORDER BY created_at";
            try (PreparedStatement ps = c.prepareStatement(sql)) {
                ps.setObject(1, projectId);
                try (ResultSet rs = ps.executeQuery()) {
                    while (rs.next()) {
                        Map<String, Object> m = new LinkedHashMap<>();
                        m.put("id", rs.getString("id"));
                        m.put("jiraProjectId", rs.getString("jira_project_id"));
                        m.put("jiraProjectKey", rs.getString("jira_project_key"));
                        m.put("jiraProjectName", rs.getString("jira_project_name"));
                        m.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
                        result.add(m);
                    }
                }
            }
        }
        return result;
    }

    // ---------- Sync tickets ----------

    public static int syncTickets(UUID projectId) throws Exception {
        String token = getValidAccessToken(projectId);
        String cloudId = getCloudId(projectId);
        UUID connectionId;
        try (Connection c = Database.getDataSource().getConnection()) {
            try (PreparedStatement ps = c.prepareStatement("SELECT id FROM jira_connections WHERE project_id = ?")) {
                ps.setObject(1, projectId);
                try (ResultSet rs = ps.executeQuery()) {
                    if (!rs.next()) throw new RuntimeException("No Jira connection");
                    connectionId = UUID.fromString(rs.getString("id"));
                }
            }
        }

        // Get connected Jira project keys
        List<String> jiraKeys = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection()) {
            try (PreparedStatement ps = c.prepareStatement(
                    "SELECT jira_project_key FROM jira_project_mappings WHERE project_id = ? AND enabled = true")) {
                ps.setObject(1, projectId);
                try (ResultSet rs = ps.executeQuery()) {
                    while (rs.next()) jiraKeys.add(rs.getString("jira_project_key"));
                }
            }
        }

        if (jiraKeys.isEmpty()) return 0;

        // Build JQL
        String projectClause = String.join(", ", jiraKeys);
        String jql = "project in (" + projectClause + ") ORDER BY updated DESC";

        int totalSynced = 0;
        int maxResults = 100;
        String nextPageToken = null;

        while (true) {
            String fieldList = "summary,description,issuetype,status,priority,assignee,reporter,labels,created,updated";
            String searchUrl = JIRA_API_BASE + cloudId + "/rest/api/3/search/jql"
                    + "?jql=" + enc(jql)
                    + "&maxResults=" + maxResults
                    + "&fields=" + enc(fieldList)
                    + (nextPageToken != null ? "&nextPageToken=" + enc(nextPageToken) : "");
            System.out.println("[JIRA] Search URL: " + searchUrl);
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(searchUrl))
                    .header("Authorization", "Bearer " + token)
                    .header("Accept", "application/json")
                    .GET()
                    .build();
            HttpResponse<String> res = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() != 200) {
                System.err.println("[JIRA] Search response " + res.statusCode() + ": " + res.body());
                throw new RuntimeException("Jira search failed: " + res.body());
            }

            JsonNode root = MAPPER.readTree(res.body());
            JsonNode issues = root.get("issues");
            if (issues == null || !issues.isArray() || issues.isEmpty()) break;

            try (Connection c = Database.getDataSource().getConnection()) {
                String sql = """
                    INSERT INTO jira_tickets
                        (project_id, jira_connection_id, jira_issue_id, jira_issue_key, summary, description,
                         issue_type, status, priority, assignee, reporter, labels, jira_created_at, jira_updated_at, jira_url, synced_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now())
                    ON CONFLICT (jira_connection_id, jira_issue_id) DO UPDATE
                        SET summary = EXCLUDED.summary,
                            description = EXCLUDED.description,
                            issue_type = EXCLUDED.issue_type,
                            status = EXCLUDED.status,
                            priority = EXCLUDED.priority,
                            assignee = EXCLUDED.assignee,
                            reporter = EXCLUDED.reporter,
                            labels = EXCLUDED.labels,
                            jira_created_at = EXCLUDED.jira_created_at,
                            jira_updated_at = EXCLUDED.jira_updated_at,
                            jira_url = EXCLUDED.jira_url,
                            synced_at = now()
                    """;
                try (PreparedStatement ps = c.prepareStatement(sql)) {
                    for (JsonNode issue : issues) {
                        JsonNode fields = issue.get("fields");
                        ps.setObject(1, projectId);
                        ps.setObject(2, connectionId);
                        ps.setString(3, issue.get("id").asText());
                        ps.setString(4, issue.get("key").asText());
                        ps.setString(5, textField(fields, "summary"));
                        ps.setString(6, descriptionToText(fields.get("description")));
                        ps.setString(7, nestedText(fields, "issuetype", "name"));
                        ps.setString(8, nestedText(fields, "status", "name"));
                        ps.setString(9, nestedText(fields, "priority", "name"));
                        ps.setString(10, nestedText(fields, "assignee", "displayName"));
                        ps.setString(11, nestedText(fields, "reporter", "displayName"));
                        ps.setString(12, labelsToString(fields.get("labels")));
                        ps.setTimestamp(13, parseIso(fields, "created"));
                        ps.setTimestamp(14, parseIso(fields, "updated"));
                        String siteUrl = getSiteUrl(projectId);
                        ps.setString(15, siteUrl + "/browse/" + issue.get("key").asText());
                        ps.addBatch();
                        totalSynced++;
                    }
                    ps.executeBatch();
                }
            }

            // Use nextPageToken for pagination (new Jira API)
            JsonNode tokenNode = root.get("nextPageToken");
            if (tokenNode != null && !tokenNode.isNull() && !tokenNode.asText().isEmpty()) {
                nextPageToken = tokenNode.asText();
            } else {
                break; // no more pages
            }
            if (totalSynced >= 1000) break; // safety cap
        }
        return totalSynced;
    }

    // ---------- Add comment to Jira issue ----------

    public static void addComment(UUID projectId, String issueIdOrKey, String commentBody,
                                   List<JiraHandler.TestCaseLink> testCases) throws Exception {
        String token = getValidAccessToken(projectId);
        String cloudId = getCloudId(projectId);
        String url = JIRA_API_BASE + cloudId + "/rest/api/3/issue/" + enc(issueIdOrKey) + "/comment";

        List<Map<String, Object>> docContent = new ArrayList<>();

        // Heading: "Test cases have been generated"
        docContent.add(Map.of(
                "type", "paragraph",
                "content", List.of(
                        Map.of("type", "text", "text", "Test cases have been generated",
                                "marks", List.of(Map.of("type", "strong")))
                )
        ));

        // Bullet list of linked test case titles
        if (testCases != null && !testCases.isEmpty()) {
            String baseUrl = Config.FRONTEND_URL + "/projects/" + projectId + "/testcases/";
            List<Map<String, Object>> listItems = new ArrayList<>();
            for (JiraHandler.TestCaseLink tc : testCases) {
                listItems.add(Map.of(
                        "type", "listItem",
                        "content", List.of(
                                Map.of("type", "paragraph",
                                        "content", List.of(
                                                Map.of("type", "text",
                                                        "text", tc.title,
                                                        "marks", List.of(Map.of(
                                                                "type", "link",
                                                                "attrs", Map.of("href", baseUrl + tc.id)
                                                        ))
                                                )
                                        ))
                        )
                ));
            }
            docContent.add(Map.of("type", "bulletList", "content", listItems));
        } else if (commentBody != null && !commentBody.isBlank()) {
            docContent.add(Map.of(
                    "type", "paragraph",
                    "content", List.of(Map.of("type", "text", "text", commentBody))
            ));
        }

        String adfBody = MAPPER.writeValueAsString(Map.of(
                "body", Map.of("version", 1, "type", "doc", "content", docContent)
        ));

        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/json")
                .header("Accept", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(adfBody))
                .build();
        HttpResponse<String> res = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() != 201 && res.statusCode() != 200) {
            System.err.println("[JIRA] addComment failed " + res.statusCode() + ": " + res.body());
            throw new RuntimeException("Failed to add Jira comment: " + res.body());
        }
    }

    // ---------- List cached tickets ----------

    public static Map<String, Object> listTickets(UUID projectId, int limit, int offset, String search) throws Exception {
        List<Map<String, Object>> tickets = new ArrayList<>();
        int total = 0;
        try (Connection c = Database.getDataSource().getConnection()) {
            StringBuilder where = new StringBuilder("WHERE project_id = ?");
            List<Object> params = new ArrayList<>();
            params.add(projectId);

            if (search != null && !search.isBlank()) {
                where.append(" AND (jira_issue_key ILIKE ? OR summary ILIKE ?)");
                String like = "%" + search.trim() + "%";
                params.add(like);
                params.add(like);
            }

            // Count
            try (PreparedStatement ps = c.prepareStatement("SELECT count(*) FROM jira_tickets " + where)) {
                for (int i = 0; i < params.size(); i++) ps.setObject(i + 1, params.get(i));
                try (ResultSet rs = ps.executeQuery()) {
                    rs.next();
                    total = rs.getInt(1);
                }
            }

            // Fetch
            String sql = "SELECT * FROM jira_tickets " + where + " ORDER BY jira_updated_at DESC NULLS LAST LIMIT ? OFFSET ?";
            try (PreparedStatement ps = c.prepareStatement(sql)) {
                int idx = 1;
                for (Object p : params) ps.setObject(idx++, p);
                ps.setInt(idx++, limit);
                ps.setInt(idx, offset);
                try (ResultSet rs = ps.executeQuery()) {
                    while (rs.next()) {
                        Map<String, Object> m = new LinkedHashMap<>();
                        m.put("id", rs.getString("id"));
                        m.put("jiraIssueId", rs.getString("jira_issue_id"));
                        m.put("jiraIssueKey", rs.getString("jira_issue_key"));
                        m.put("summary", rs.getString("summary"));
                        m.put("description", rs.getString("description"));
                        m.put("issueType", rs.getString("issue_type"));
                        m.put("status", rs.getString("status"));
                        m.put("priority", rs.getString("priority"));
                        m.put("assignee", rs.getString("assignee"));
                        m.put("reporter", rs.getString("reporter"));
                        m.put("labels", rs.getString("labels"));
                        m.put("jiraUrl", rs.getString("jira_url"));
                        Timestamp jiraCreated = rs.getTimestamp("jira_created_at");
                        m.put("jiraCreatedAt", jiraCreated != null ? jiraCreated.toInstant().toString() : null);
                        Timestamp jiraUpdated = rs.getTimestamp("jira_updated_at");
                        m.put("jiraUpdatedAt", jiraUpdated != null ? jiraUpdated.toInstant().toString() : null);
                        Timestamp synced = rs.getTimestamp("synced_at");
                        m.put("syncedAt", synced != null ? synced.toInstant().toString() : null);
                        tickets.add(m);
                    }
                }
            }
        }
        return Map.of("list", tickets, "total", total);
    }

    // ---------- Utility ----------

    private static String getSiteUrl(UUID projectId) throws Exception {
        try (Connection c = Database.getDataSource().getConnection()) {
            try (PreparedStatement ps = c.prepareStatement("SELECT site_url FROM jira_connections WHERE project_id = ?")) {
                ps.setObject(1, projectId);
                try (ResultSet rs = ps.executeQuery()) {
                    return rs.next() ? rs.getString("site_url") : "";
                }
            }
        }
    }

    private static String enc(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }

    private static String textField(JsonNode fields, String key) {
        JsonNode n = fields.get(key);
        return n != null && !n.isNull() ? n.asText() : "";
    }

    private static String nestedText(JsonNode fields, String obj, String key) {
        JsonNode n = fields.get(obj);
        if (n == null || n.isNull()) return "";
        JsonNode v = n.get(key);
        return v != null && !v.isNull() ? v.asText() : "";
    }

    private static String labelsToString(JsonNode labels) {
        if (labels == null || !labels.isArray()) return "";
        List<String> list = new ArrayList<>();
        for (JsonNode l : labels) list.add(l.asText());
        return String.join(", ", list);
    }

    private static String descriptionToText(JsonNode desc) {
        if (desc == null || desc.isNull()) return "";
        if (desc.isTextual()) return desc.asText();
        // ADF (Atlassian Document Format) — extract text nodes recursively
        StringBuilder sb = new StringBuilder();
        extractText(desc, sb);
        return sb.toString().trim();
    }

    private static void extractText(JsonNode node, StringBuilder sb) {
        if (node == null) return;
        if (node.has("text")) {
            sb.append(node.get("text").asText());
        }
        JsonNode content = node.get("content");
        if (content != null && content.isArray()) {
            for (JsonNode child : content) {
                extractText(child, sb);
            }
            if ("paragraph".equals(node.has("type") ? node.get("type").asText() : "")) {
                sb.append("\n");
            }
        }
    }

    private static Timestamp parseIso(JsonNode fields, String key) {
        JsonNode n = fields.get(key);
        if (n == null || n.isNull()) return null;
        try {
            return Timestamp.from(OffsetDateTime.parse(n.asText()).toInstant());
        } catch (Exception e) {
            return null;
        }
    }

    private JiraService() {}
}
