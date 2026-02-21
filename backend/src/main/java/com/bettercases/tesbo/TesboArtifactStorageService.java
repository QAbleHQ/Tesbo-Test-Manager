package com.bettercases.tesbo;

import com.bettercases.Config;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import software.amazon.awssdk.services.s3.presigner.model.GetObjectPresignRequest;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;

public final class TesboArtifactStorageService {
    public record ArtifactLocation(String storageKey, String directUrl) {}
    public record ArtifactReadResult(boolean redirect, String redirectUrl, InputStream stream, String contentType) {}

    private static final boolean SPACES_ENABLED = "spaces".equalsIgnoreCase(Config.TESBO_ARTIFACT_STORAGE_PROVIDER);
    private static final Path LOCAL_ROOT = Path.of(Config.UPLOAD_DIR, "tesbo-artifacts");
    private static final S3Client S3 = createS3Client();
    private static final S3Presigner PRESIGNER = createPresigner();

    private TesboArtifactStorageService() {}

    public static ArtifactLocation store(String storageKey, byte[] bytes, String contentType) {
        if (bytes == null || bytes.length == 0) {
            return new ArtifactLocation(null, null);
        }

        if (SPACES_ENABLED && S3 != null) {
            PutObjectRequest request = PutObjectRequest.builder()
                .bucket(Config.TESBO_SPACES_BUCKET)
                .key(storageKey)
                .contentType(contentType)
                .build();
            S3.putObject(request, RequestBody.fromBytes(bytes));
            return new ArtifactLocation(storageKey, null);
        }

        Path path = LOCAL_ROOT.resolve(storageKey);
        try {
            Files.createDirectories(path.getParent());
            Files.write(path, bytes);
        } catch (IOException e) {
            throw new RuntimeException("Failed to store local Tesbo artifact", e);
        }
        return new ArtifactLocation(storageKey, null);
    }

    public static ArtifactReadResult read(String storageKey, String fallbackUrl, String contentType) {
        if (storageKey == null || storageKey.isBlank()) {
            if (fallbackUrl != null && !fallbackUrl.isBlank()) {
                return new ArtifactReadResult(true, fallbackUrl, null, contentType);
            }
            return null;
        }

        if (SPACES_ENABLED && PRESIGNER != null) {
            GetObjectRequest getReq = GetObjectRequest.builder()
                .bucket(Config.TESBO_SPACES_BUCKET)
                .key(storageKey)
                .build();
            GetObjectPresignRequest presignRequest = GetObjectPresignRequest.builder()
                .signatureDuration(Duration.ofSeconds(Math.max(60, Config.TESBO_SIGNED_URL_TTL_SECONDS)))
                .getObjectRequest(getReq)
                .build();
            String url = PRESIGNER.presignGetObject(presignRequest).url().toString();
            return new ArtifactReadResult(true, url, null, contentType);
        }

        Path path = LOCAL_ROOT.resolve(storageKey);
        if (!Files.exists(path)) {
            if (fallbackUrl != null && !fallbackUrl.isBlank()) {
                return new ArtifactReadResult(true, fallbackUrl, null, contentType);
            }
            return null;
        }
        try {
            return new ArtifactReadResult(false, null, Files.newInputStream(path), contentType);
        } catch (IOException e) {
            throw new RuntimeException("Failed to read local Tesbo artifact", e);
        }
    }

    public static String resolveDirectUrlIfAvailable(String storageKey) {
        if (storageKey == null || storageKey.isBlank()) {
            return null;
        }
        if (SPACES_ENABLED && PRESIGNER != null) {
            GetObjectRequest getReq = GetObjectRequest.builder()
                .bucket(Config.TESBO_SPACES_BUCKET)
                .key(storageKey)
                .build();
            GetObjectPresignRequest presignRequest = GetObjectPresignRequest.builder()
                .signatureDuration(Duration.ofSeconds(Math.max(60, Config.TESBO_SIGNED_URL_TTL_SECONDS)))
                .getObjectRequest(getReq)
                .build();
            return PRESIGNER.presignGetObject(presignRequest).url().toString();
        }
        return null;
    }

    private static S3Client createS3Client() {
        if (!SPACES_ENABLED) return null;
        if (Config.TESBO_SPACES_ENDPOINT.isBlank() || Config.TESBO_SPACES_BUCKET.isBlank()) return null;
        if (Config.TESBO_SPACES_ACCESS_KEY.isBlank() || Config.TESBO_SPACES_SECRET_KEY.isBlank()) return null;

        return S3Client.builder()
            .endpointOverride(URI.create(Config.TESBO_SPACES_ENDPOINT))
            .region(Region.of(Config.TESBO_SPACES_REGION))
            .credentialsProvider(StaticCredentialsProvider.create(
                AwsBasicCredentials.create(Config.TESBO_SPACES_ACCESS_KEY, Config.TESBO_SPACES_SECRET_KEY)
            ))
            .forcePathStyle(true)
            .build();
    }

    private static S3Presigner createPresigner() {
        if (!SPACES_ENABLED) return null;
        if (Config.TESBO_SPACES_ENDPOINT.isBlank() || Config.TESBO_SPACES_BUCKET.isBlank()) return null;
        if (Config.TESBO_SPACES_ACCESS_KEY.isBlank() || Config.TESBO_SPACES_SECRET_KEY.isBlank()) return null;

        return S3Presigner.builder()
            .endpointOverride(URI.create(Config.TESBO_SPACES_ENDPOINT))
            .region(Region.of(Config.TESBO_SPACES_REGION))
            .credentialsProvider(StaticCredentialsProvider.create(
                AwsBasicCredentials.create(Config.TESBO_SPACES_ACCESS_KEY, Config.TESBO_SPACES_SECRET_KEY)
            ))
            .build();
    }

    public static byte[] decodeBase64(Object value) {
        if (value == null) return null;
        String raw = String.valueOf(value).trim();
        if (raw.isBlank()) return null;
        int comma = raw.indexOf(',');
        if (raw.startsWith("data:") && comma > 0) {
            raw = raw.substring(comma + 1);
        }
        try {
            return java.util.Base64.getDecoder().decode(raw);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    public static String extensionFor(String kind, String contentType) {
        Map<String, String> byType = Map.of(
            "application/zip", "zip",
            "application/x-zip-compressed", "zip",
            "image/png", "png",
            "image/jpeg", "jpg",
            "video/mp4", "mp4",
            "video/webm", "webm"
        );
        String ext = byType.getOrDefault(contentType == null ? "" : contentType.toLowerCase(), null);
        if (ext != null) return ext;
        return switch (kind) {
            case "trace" -> "zip";
            case "screenshot" -> "png";
            default -> "webm";
        };
    }
}
