package com.bettercases.auth;

import com.bettercases.Config;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

/**
 * Sends emails via Postmark API.
 */
public final class EmailService {
    private static final String POSTMARK_API = "https://api.postmarkapp.com/email";
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

    public void sendOtp(String toEmail, String otpCode) {
        if (Config.POSTMARK_API_TOKEN == null || Config.POSTMARK_API_TOKEN.isEmpty()) {
            System.err.println("[EmailService] POSTMARK_API_TOKEN not set; would send OTP to " + toEmail + ": " + otpCode);
            return;
        }
        String body = """
            {"From":"%s","To":"%s","Subject":"Your login code","TextBody":"Your verification code is: %s\\n\\nIt expires in %d minutes. Do not share this code."}
            """.formatted(Config.POSTMARK_FROM_EMAIL, toEmail, otpCode, Config.OTP_EXPIRY_MINUTES);
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(POSTMARK_API))
                    .header("Content-Type", "application/json")
                    .header("X-Postmark-Server-Token", Config.POSTMARK_API_TOKEN)
                    .timeout(Duration.ofSeconds(15))
                    .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                    .build();
            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() >= 400) {
                throw new RuntimeException("Postmark returned " + response.statusCode() + ": " + response.body());
            }
        } catch (Exception e) {
            throw new RuntimeException("Failed to send OTP email", e);
        }
    }

    public void sendEmail(String toEmail, String subject, String textBody) {
        if (toEmail == null || toEmail.isBlank()) return;
        if (Config.POSTMARK_API_TOKEN == null || Config.POSTMARK_API_TOKEN.isEmpty()) {
            System.err.println("[EmailService] POSTMARK_API_TOKEN not set; would send mail to " + toEmail + " subject=" + subject);
            return;
        }
        String body = """
            {"From":"%s","To":"%s","Subject":"%s","TextBody":"%s"}
            """.formatted(
                escapeJson(Config.POSTMARK_FROM_EMAIL),
                escapeJson(toEmail),
                escapeJson(subject == null ? "" : subject),
                escapeJson(textBody == null ? "" : textBody)
            );
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(POSTMARK_API))
                    .header("Content-Type", "application/json")
                    .header("X-Postmark-Server-Token", Config.POSTMARK_API_TOKEN)
                    .timeout(Duration.ofSeconds(15))
                    .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                    .build();
            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() >= 400) {
                throw new RuntimeException("Postmark returned " + response.statusCode() + ": " + response.body());
            }
        } catch (Exception e) {
            throw new RuntimeException("Failed to send email", e);
        }
    }

    private static String escapeJson(String value) {
        return value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r");
    }
}
