package com.bettercases.knowledgebase;

import com.bettercases.Config;
import com.bettercases.Database;
import com.bettercases.rbac.RbacService;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.sql.*;
import java.util.*;

public final class KnowledgeBaseService {

    public static Map<String, Object> list(UUID projectId, UUID userId, String search, String type) {
        RbacService.requireProjectRole(userId, projectId);

        StringBuilder sql = new StringBuilder("""
            SELECT k.id, k.item_type, k.title, k.content, k.file_name,
                   k.file_content_type, k.file_size, k.created_by, k.created_at, k.updated_at,
                   u.name AS creator_name, u.email AS creator_email
            FROM knowledge_base_items k
            LEFT JOIN users u ON u.id = k.created_by
            WHERE k.project_id = ?
            """);
        List<Object> params = new ArrayList<>();
        params.add(projectId);

        if (type != null && !type.isBlank()) {
            sql.append(" AND k.item_type = ?");
            params.add(type);
        }
        if (search != null && !search.isBlank()) {
            sql.append(" AND (k.title ILIKE ? OR k.content ILIKE ?)");
            String pattern = "%" + search + "%";
            params.add(pattern);
            params.add(pattern);
        }
        sql.append(" ORDER BY k.created_at DESC");

        List<Map<String, Object>> items = new ArrayList<>();
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql.toString())) {
            for (int i = 0; i < params.size(); i++) {
                ps.setObject(i + 1, params.get(i));
            }
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                items.add(mapRow(rs));
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("list", items);
        result.put("total", items.size());
        return result;
    }

    public static Map<String, Object> createNote(UUID projectId, UUID userId, String title, String content) {
        RbacService.requireProjectRole(userId, projectId);

        String sql = """
            INSERT INTO knowledge_base_items (project_id, item_type, title, content, created_by)
            VALUES (?, 'note', ?, ?, ?)
            RETURNING id, created_at, updated_at
            """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ps.setString(2, title);
            ps.setString(3, content != null ? content : "");
            ps.setObject(4, userId);
            ResultSet rs = ps.executeQuery();
            rs.next();
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", rs.getObject("id").toString());
            m.put("itemType", "note");
            m.put("title", title);
            m.put("content", content != null ? content : "");
            m.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
            m.put("updatedAt", rs.getTimestamp("updated_at").toInstant().toString());
            return m;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static Map<String, Object> uploadFile(UUID projectId, UUID userId,
                                                   String fileName, String contentType,
                                                   long fileSize, InputStream fileStream) {
        RbacService.requireProjectRole(userId, projectId);

        UUID itemId = UUID.randomUUID();
        Path dir = Path.of(Config.UPLOAD_DIR, "kb", projectId.toString());
        try {
            Files.createDirectories(dir);
        } catch (IOException e) {
            throw new RuntimeException("Failed to create upload directory", e);
        }

        String storedName = itemId + "_" + sanitizeFileName(fileName);
        Path filePath = dir.resolve(storedName);
        try {
            Files.copy(fileStream, filePath, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            throw new RuntimeException("Failed to save uploaded file", e);
        }

        String textContent = null;
        if (isTextBasedContentType(contentType)) {
            try {
                textContent = Files.readString(filePath);
                if (textContent.length() > 500_000) {
                    textContent = textContent.substring(0, 500_000);
                }
            } catch (IOException ignored) { }
        }

        String title = fileName;
        String storagePath = filePath.toString();

        String sql = """
            INSERT INTO knowledge_base_items
                (id, project_id, item_type, title, content, file_name, file_content_type, file_size, storage_path, created_by)
            VALUES (?, ?, 'file', ?, ?, ?, ?, ?, ?, ?)
            RETURNING created_at, updated_at
            """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, itemId);
            ps.setObject(2, projectId);
            ps.setString(3, title);
            ps.setString(4, textContent);
            ps.setString(5, fileName);
            ps.setString(6, contentType);
            ps.setLong(7, fileSize);
            ps.setString(8, storagePath);
            ps.setObject(9, userId);
            ResultSet rs = ps.executeQuery();
            rs.next();

            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", itemId.toString());
            m.put("itemType", "file");
            m.put("title", title);
            m.put("content", textContent);
            m.put("fileName", fileName);
            m.put("fileContentType", contentType);
            m.put("fileSize", fileSize);
            m.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
            m.put("updatedAt", rs.getTimestamp("updated_at").toInstant().toString());
            return m;
        } catch (SQLException e) {
            try { Files.deleteIfExists(filePath); } catch (IOException ignored) { }
            throw new RuntimeException(e);
        }
    }

    public static Optional<Map<String, Object>> get(UUID itemId, UUID userId) {
        String sql = """
            SELECT k.id, k.project_id, k.item_type, k.title, k.content, k.file_name,
                   k.file_content_type, k.file_size, k.storage_path, k.created_by,
                   k.created_at, k.updated_at,
                   u.name AS creator_name, u.email AS creator_email
            FROM knowledge_base_items k
            LEFT JOIN users u ON u.id = k.created_by
            WHERE k.id = ?
            """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, itemId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) {
                UUID projectId = (UUID) rs.getObject("project_id");
                RbacService.requireProjectRole(userId, projectId);
                Map<String, Object> row = mapRow(rs);
                row.put("storagePath", rs.getString("storage_path"));
                return Optional.of(row);
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return Optional.empty();
    }

    public static void update(UUID itemId, UUID userId, String title, String content) {
        UUID projectId = getProjectId(itemId);
        RbacService.requireProjectRole(userId, projectId);

        String sql = """
            UPDATE knowledge_base_items SET
              title = COALESCE(?, title),
              content = COALESCE(?, content),
              updated_at = now()
            WHERE id = ?
            """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, title);
            ps.setString(2, content);
            ps.setObject(3, itemId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public static void delete(UUID itemId, UUID userId) {
        UUID projectId = getProjectId(itemId);
        RbacService.requireProjectRole(userId, projectId);

        String storagePath = getStoragePath(itemId);
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("DELETE FROM knowledge_base_items WHERE id = ?")) {
            ps.setObject(1, itemId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }

        if (storagePath != null && !storagePath.isBlank()) {
            try { Files.deleteIfExists(Path.of(storagePath)); } catch (IOException ignored) { }
        }
    }

    public static FileInfo getFileInfo(UUID itemId, UUID userId) {
        String sql = """
            SELECT project_id, file_name, file_content_type, storage_path
            FROM knowledge_base_items
            WHERE id = ? AND item_type = 'file'
            """;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, itemId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) {
                UUID projectId = (UUID) rs.getObject("project_id");
                RbacService.requireProjectRole(userId, projectId);
                return new FileInfo(
                    rs.getString("file_name"),
                    rs.getString("file_content_type"),
                    rs.getString("storage_path")
                );
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return null;
    }

    public record FileInfo(String fileName, String contentType, String storagePath) {}

    private static Map<String, Object> mapRow(ResultSet rs) throws SQLException {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", rs.getObject("id").toString());
        m.put("itemType", rs.getString("item_type"));
        m.put("title", rs.getString("title"));
        String content = rs.getString("content");
        m.put("content", content != null ? content : "");
        String fn = rs.getString("file_name");
        m.put("fileName", fn);
        m.put("fileContentType", rs.getString("file_content_type"));
        long size = rs.getLong("file_size");
        m.put("fileSize", rs.wasNull() ? null : size);
        Object createdBy = rs.getObject("created_by");
        m.put("createdBy", createdBy != null ? createdBy.toString() : null);
        m.put("creatorName", rs.getString("creator_name") != null ? rs.getString("creator_name") : "");
        m.put("creatorEmail", rs.getString("creator_email") != null ? rs.getString("creator_email") : "");
        m.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
        m.put("updatedAt", rs.getTimestamp("updated_at").toInstant().toString());
        return m;
    }

    private static UUID getProjectId(UUID itemId) {
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("SELECT project_id FROM knowledge_base_items WHERE id = ?")) {
            ps.setObject(1, itemId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) return (UUID) rs.getObject("project_id");
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        throw new io.javalin.http.NotFoundResponse();
    }

    private static String getStoragePath(UUID itemId) {
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("SELECT storage_path FROM knowledge_base_items WHERE id = ?")) {
            ps.setObject(1, itemId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) return rs.getString("storage_path");
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return null;
    }

    private static String sanitizeFileName(String fileName) {
        if (fileName == null) return "file";
        return fileName.replaceAll("[^a-zA-Z0-9._-]", "_");
    }

    private static boolean isTextBasedContentType(String ct) {
        if (ct == null) return false;
        String lower = ct.toLowerCase();
        return lower.startsWith("text/")
            || lower.equals("application/json")
            || lower.equals("application/xml")
            || lower.equals("application/x-yaml")
            || lower.contains("yaml")
            || lower.contains("csv");
    }

    private KnowledgeBaseService() {}
}
