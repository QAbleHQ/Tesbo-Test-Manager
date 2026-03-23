package com.bettercases.knowledgebase;

import com.bettercases.Config;
import com.bettercases.auth.SessionFilter;
import io.javalin.http.Context;
import io.javalin.http.UploadedFile;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.UUID;

public final class KnowledgeBaseHandler {

    public static void list(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        String search = ctx.queryParam("search");
        String type = ctx.queryParam("type");
        ctx.json(KnowledgeBaseService.list(projectId, userId, search, type));
    }

    public static void get(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID itemId = UUID.fromString(ctx.pathParam("itemId"));
        ctx.json(KnowledgeBaseService.get(itemId, userId)
                .orElseThrow(() -> new io.javalin.http.NotFoundResponse()));
    }

    public static void createNote(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        NoteBody body = ctx.bodyAsClass(NoteBody.class);
        if (body == null || body.title == null || body.title.isBlank()) {
            ctx.status(400).json(Map.of("error", "title is required"));
            return;
        }
        ctx.status(201).json(KnowledgeBaseService.createNote(projectId, userId, body.title, body.content));
    }

    public static void upload(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));

        UploadedFile uploaded = ctx.uploadedFile("file");
        if (uploaded == null) {
            ctx.status(400).json(Map.of("error", "file is required"));
            return;
        }
        if (uploaded.size() > Config.MAX_UPLOAD_SIZE) {
            ctx.status(400).json(Map.of("error", "File too large. Maximum size is 10 MB."));
            return;
        }

        String fileName = uploaded.filename();
        String contentType = uploaded.contentType() != null ? uploaded.contentType() : "application/octet-stream";
        long fileSize = uploaded.size();

        try (InputStream stream = uploaded.content()) {
            ctx.status(201).json(KnowledgeBaseService.uploadFile(
                    projectId, userId, fileName, contentType, fileSize, stream));
        } catch (Exception e) {
            throw new RuntimeException("Upload failed", e);
        }
    }

    public static void update(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID itemId = UUID.fromString(ctx.pathParam("itemId"));
        NoteBody body = ctx.bodyAsClass(NoteBody.class);
        if (body == null) body = new NoteBody();
        KnowledgeBaseService.update(itemId, userId, body.title, body.content);
        ctx.status(204);
    }

    public static void delete(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID itemId = UUID.fromString(ctx.pathParam("itemId"));
        KnowledgeBaseService.delete(itemId, userId);
        ctx.status(204);
    }

    public static void downloadFile(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID itemId = UUID.fromString(ctx.pathParam("itemId"));

        KnowledgeBaseService.FileInfo info = KnowledgeBaseService.getFileInfo(itemId, userId);
        if (info == null || info.storagePath() == null) {
            throw new io.javalin.http.NotFoundResponse();
        }

        Path path = Path.of(info.storagePath());
        if (!Files.exists(path)) {
            throw new io.javalin.http.NotFoundResponse();
        }

        ctx.contentType(info.contentType() != null ? info.contentType() : "application/octet-stream");
        ctx.header("Content-Disposition", "inline; filename=\"" + (info.fileName() != null ? info.fileName() : "file") + "\"");
        try {
            ctx.result(Files.newInputStream(path));
        } catch (Exception e) {
            throw new RuntimeException("Failed to read file", e);
        }
    }

    public static class NoteBody {
        public String title;
        public String content;
    }
}
