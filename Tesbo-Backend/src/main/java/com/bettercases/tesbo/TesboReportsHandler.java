package com.bettercases.tesbo;

import com.bettercases.Config;
import com.bettercases.auth.SessionFilter;
import io.javalin.http.Context;
import io.javalin.http.UploadedFile;

import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

public final class TesboReportsHandler {
    private TesboReportsHandler() {}

    public static void listRuns(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        ctx.json(TesboReportsService.listRuns(projectId, userId));
    }

    public static void getRun(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID runId = UUID.fromString(ctx.pathParam("runId"));
        ctx.json(TesboReportsService.getRun(projectId, userId, runId)
            .orElseThrow(() -> new io.javalin.http.NotFoundResponse("Run not found")));
    }

    public static void listSpecs(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        ctx.json(TesboReportsService.listSpecs(projectId, userId));
    }

    public static void getSpec(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        String specName = ctx.pathParam("specName");
        ctx.json(TesboReportsService.getSpec(projectId, userId, specName));
    }

    public static void getTestHistory(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        String specName = ctx.pathParam("specName");
        String testName = ctx.pathParam("testName");
        ctx.json(TesboReportsService.getTestHistory(projectId, userId, specName, testName));
    }

    public static void listTests(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        ctx.json(TesboReportsService.listTests(projectId, userId));
    }

    public static void analytics(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        ctx.json(TesboReportsService.analytics(projectId, userId));
    }

    public static void listAlerts(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        ctx.json(TesboReportsService.listAlerts(projectId, userId));
    }

    @SuppressWarnings("unchecked")
    public static void createAlert(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        Map<String, Object> payload = ctx.bodyAsClass(HashMap.class);
        ctx.status(201).json(TesboReportsService.createAlert(projectId, userId, payload));
    }

    @SuppressWarnings("unchecked")
    public static void updateAlert(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID alertId = UUID.fromString(ctx.pathParam("alertId"));
        Map<String, Object> payload = ctx.bodyAsClass(HashMap.class);
        ctx.json(TesboReportsService.updateAlert(projectId, userId, alertId, payload));
    }

    public static void deleteAlert(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID alertId = UUID.fromString(ctx.pathParam("alertId"));
        TesboReportsService.deleteAlert(projectId, userId, alertId);
        ctx.status(204);
    }

    @SuppressWarnings("unchecked")
    public static void toggleAlert(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID alertId = UUID.fromString(ctx.pathParam("alertId"));
        Map<String, Object> body = ctx.bodyAsClass(HashMap.class);
        boolean enabled = body != null && Boolean.TRUE.equals(body.get("enabled"));
        ctx.json(TesboReportsService.toggleAlert(projectId, userId, alertId, enabled));
    }

    public static void sendTestAlert(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID alertId = UUID.fromString(ctx.pathParam("alertId"));
        TesboReportsService.sendTestAlert(projectId, userId, alertId);
        ctx.status(204);
    }

    public static void getShare(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID runId = UUID.fromString(ctx.pathParam("runId"));
        ctx.json(TesboReportsService.getShareState(projectId, userId, runId, ctx.scheme() + "://" + ctx.host()));
    }

    @SuppressWarnings("unchecked")
    public static void createShare(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID runId = UUID.fromString(ctx.pathParam("runId"));
        Map<String, Object> body = ctx.bodyAsClass(HashMap.class);
        int expiresInHours = 168;
        if (body != null && body.get("expiresInHours") instanceof Number n) {
            expiresInHours = n.intValue();
        }
        ctx.json(TesboReportsService.createShare(projectId, userId, runId, expiresInHours, ctx.scheme() + "://" + ctx.host()));
    }

    public static void disableShare(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID runId = UUID.fromString(ctx.pathParam("runId"));
        TesboReportsService.disableShare(projectId, userId, runId);
        ctx.status(204);
    }

    public static void getPublicSharedRun(Context ctx) {
        String token = ctx.pathParam("token");
        ctx.json(TesboReportsService.getSharedRunByToken(token)
            .orElseThrow(() -> new io.javalin.http.NotFoundResponse("Shared run not found")));
    }

    public static void getPublicSharedArtifact(Context ctx) {
        String token = ctx.pathParam("token");
        UUID caseId = UUID.fromString(ctx.pathParam("caseId"));
        String kind = ctx.pathParam("kind");
        TesboArtifactStorageService.ArtifactReadResult result =
            TesboReportsService.getSharedCaseArtifact(token, caseId, kind);
        if (result == null) {
            throw new io.javalin.http.NotFoundResponse("Artifact not found");
        }
        if (result.redirect()) {
            ctx.redirect(result.redirectUrl());
            return;
        }
        if (result.contentType() != null) {
            ctx.contentType(result.contentType());
        }
        ctx.result(result.stream());
    }

    public static void getCaseArtifact(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID caseId = UUID.fromString(ctx.pathParam("caseId"));
        String kind = ctx.pathParam("kind");
        TesboArtifactStorageService.ArtifactReadResult result =
            TesboReportsService.getCaseArtifact(projectId, userId, caseId, kind);
        if (result == null) {
            throw new io.javalin.http.NotFoundResponse("Artifact not found");
        }
        if (result.redirect()) {
            ctx.redirect(result.redirectUrl());
            return;
        }
        if (result.contentType() != null) {
            ctx.contentType(result.contentType());
        }
        ctx.result(result.stream());
    }

    public static void getSettings(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        ctx.json(TesboReportsService.getSettings(projectId, userId));
    }

    @SuppressWarnings("unchecked")
    public static void updateSettings(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        Map<String, Object> payload = ctx.bodyAsClass(HashMap.class);
        ctx.json(TesboReportsService.updateSettings(projectId, userId, payload));
    }

    public static void rotateIngestionKey(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        ctx.json(TesboReportsService.rotateIngestionKey(projectId, userId));
    }

    @SuppressWarnings("unchecked")
    public static void ingestPlaywright(Context ctx) {
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        Map<String, Object> payload = ctx.bodyAsClass(HashMap.class);
        String ingestionKey = extractIngestionKey(ctx);
        if (ingestionKey != null && !ingestionKey.isBlank()) {
            ctx.status(201).json(TesboReportsService.ingestPlaywrightWithIngestionKey(projectId, ingestionKey, payload == null ? Map.of() : payload));
            return;
        }
        UUID userId = SessionFilter.requireUserId(ctx);
        ctx.status(201).json(TesboReportsService.ingestPlaywright(projectId, userId, payload == null ? Map.of() : payload));
    }

    @SuppressWarnings("unchecked")
    public static void ingestPlaywrightByKey(Context ctx) {
        String ingestionKey = extractIngestionKey(ctx);
        if (ingestionKey == null || ingestionKey.isBlank()) {
            throw new io.javalin.http.UnauthorizedResponse("Project access key is required");
        }
        Map<String, Object> payload = ctx.bodyAsClass(HashMap.class);
        ctx.status(201).json(TesboReportsService.ingestPlaywrightWithIngestionKey(ingestionKey, payload == null ? Map.of() : payload));
    }

    public static void ingestPlaywrightFile(Context ctx) {
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UploadedFile uploaded = ctx.uploadedFile("result");
        if (uploaded == null) {
            ctx.status(400).json(Map.of("error", "result file is required"));
            return;
        }
        if (uploaded.size() > Config.MAX_UPLOAD_SIZE) {
            ctx.status(400).json(Map.of("error", "File too large"));
            return;
        }
        try (InputStream in = uploaded.content()) {
            byte[] bytes = in.readAllBytes();
            String ingestionKey = extractIngestionKey(ctx);
            if (ingestionKey != null && !ingestionKey.isBlank()) {
                ctx.status(201).json(TesboReportsService.ingestPlaywrightFileWithIngestionKey(projectId, ingestionKey, bytes));
                return;
            }
            UUID userId = SessionFilter.requireUserId(ctx);
            ctx.status(201).json(TesboReportsService.ingestPlaywrightFile(projectId, userId, bytes));
        } catch (Exception e) {
            throw new RuntimeException("Failed to ingest uploaded result", e);
        }
    }

    public static void ingestPlaywrightFileByKey(Context ctx) {
        UploadedFile uploaded = ctx.uploadedFile("result");
        if (uploaded == null) {
            ctx.status(400).json(Map.of("error", "result file is required"));
            return;
        }
        if (uploaded.size() > Config.MAX_UPLOAD_SIZE) {
            ctx.status(400).json(Map.of("error", "File too large"));
            return;
        }
        String ingestionKey = extractIngestionKey(ctx);
        if (ingestionKey == null || ingestionKey.isBlank()) {
            throw new io.javalin.http.UnauthorizedResponse("Project access key is required");
        }
        try (InputStream in = uploaded.content()) {
            byte[] bytes = in.readAllBytes();
            ctx.status(201).json(TesboReportsService.ingestPlaywrightFileWithIngestionKey(ingestionKey, bytes));
        } catch (Exception e) {
            throw new RuntimeException("Failed to ingest uploaded result", e);
        }
    }

    public static void uploadCaseArtifact(Context ctx) {
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        UUID runId = UUID.fromString(ctx.pathParam("runId"));
        UUID caseId = UUID.fromString(ctx.pathParam("caseId"));
        String kind = ctx.pathParam("kind");
        UploadedFile uploaded = ctx.uploadedFile("file");
        if (uploaded == null) {
            ctx.status(400).json(Map.of("error", "file is required"));
            return;
        }
        if (uploaded.size() > Config.MAX_UPLOAD_SIZE) {
            ctx.status(400).json(Map.of("error", "File too large"));
            return;
        }
        try (InputStream in = uploaded.content()) {
            byte[] bytes = in.readAllBytes();
            String contentType = uploaded.contentType() != null ? uploaded.contentType() : "application/octet-stream";
            String ingestionKey = extractIngestionKey(ctx);
            if (ingestionKey != null && !ingestionKey.isBlank()) {
                ctx.status(201).json(TesboReportsService.uploadCaseArtifactWithIngestionKey(
                    projectId, ingestionKey, runId, caseId, kind, uploaded.filename(), contentType, bytes
                ));
                return;
            }
            UUID userId = SessionFilter.requireUserId(ctx);
            ctx.status(201).json(TesboReportsService.uploadCaseArtifact(
                projectId, userId, runId, caseId, kind, uploaded.filename(), contentType, bytes
            ));
        } catch (Exception e) {
            throw new RuntimeException("Failed to upload artifact", e);
        }
    }

    public static void uploadCaseArtifactByKey(Context ctx) {
        UUID runId = UUID.fromString(ctx.pathParam("runId"));
        UUID caseId = UUID.fromString(ctx.pathParam("caseId"));
        String kind = ctx.pathParam("kind");
        UploadedFile uploaded = ctx.uploadedFile("file");
        if (uploaded == null) {
            ctx.status(400).json(Map.of("error", "file is required"));
            return;
        }
        if (uploaded.size() > Config.MAX_UPLOAD_SIZE) {
            ctx.status(400).json(Map.of("error", "File too large"));
            return;
        }
        String ingestionKey = extractIngestionKey(ctx);
        if (ingestionKey == null || ingestionKey.isBlank()) {
            throw new io.javalin.http.UnauthorizedResponse("Project access key is required");
        }
        try (InputStream in = uploaded.content()) {
            byte[] bytes = in.readAllBytes();
            String contentType = uploaded.contentType() != null ? uploaded.contentType() : "application/octet-stream";
            ctx.status(201).json(TesboReportsService.uploadCaseArtifactWithIngestionKey(
                ingestionKey, runId, caseId, kind, uploaded.filename(), contentType, bytes
            ));
        } catch (Exception e) {
            throw new RuntimeException("Failed to upload artifact", e);
        }
    }

    private static String extractIngestionKey(Context ctx) {
        String fromHeader = firstNonBlank(
            ctx.header("x-project-access-key"),
            ctx.header("x-tesbo-access-key")
        );
        if (fromHeader != null) return fromHeader;

        String auth = ctx.header("authorization");
        if (auth != null && auth.toLowerCase().startsWith("bearer ")) {
            String bearerToken = auth.substring(7).trim();
            if (!bearerToken.isBlank() && bearerToken.startsWith("tesbo_")) {
                return bearerToken;
            }
        }
        return null;
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) return value.trim();
        }
        return null;
    }
}
