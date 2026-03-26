package com.bettercases.auth;

import com.bettercases.Config;
import com.bettercases.admin.SuperAdminService;
import com.bettercases.audit.AuditService;
import io.javalin.http.Context;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

public final class AuthHandler {
    private static final OtpService otpService = new OtpService();

    public static void requestOtp(Context ctx) {
        String body = ctx.body();
        String email = body != null && body.contains("email") ? parseEmailFromBody(body) : null;
        if (email == null) {
            ctx.status(400).json(Map.of("error", "email required"));
            return;
        }
        String ip = ctx.ip();
        String ua = ctx.userAgent();
        boolean sent;
        try {
            sent = otpService.requestOtp(email, ip, ua);
        } catch (RuntimeException e) {
            ctx.status(502).json(Map.of("error", "otp_delivery_failed"));
            return;
        }
        if (!sent) {
            ctx.status(429).json(Map.of("error", "rate_limited_or_invalid"));
            return;
        }
        AuditService.log("otp_requested", "auth", email, "{}", ip, ua);
        ctx.status(204);
    }

    public static void verifyOtp(Context ctx) {
        VerifyRequest req = ctx.bodyAsClass(VerifyRequest.class);
        if (req == null || req.email == null || req.code == null) {
            ctx.status(400).json(Map.of("error", "email and code required"));
            return;
        }
        String ip = ctx.ip();
        String ua = ctx.userAgent();
        var token = otpService.verifyOtp(req.email.trim(), req.code, ip, ua);
        if (token.isEmpty()) {
            ctx.status(401).json(Map.of("error", "invalid_or_expired_otp"));
            return;
        }
        UUID userId = otpService.resolveSession(token.get()).orElseThrow();
        AuditService.log(userId, "login", "auth", req.email, "{}", ip, ua);
        ctx.cookie(Config.SESSION_COOKIE_NAME, token.get(), 86400 * Config.SESSION_DAYS);
        ctx.json(Map.of("ok", true, "userId", userId.toString()));
    }

    public static void logout(Context ctx) {
        String token = ctx.cookie(Config.SESSION_COOKIE_NAME);
        UUID userId = SessionFilter.getUserId(ctx).orElse(null);
        if (token != null) {
            // Invalidate session by clearing cookie; optional: delete from DB
            ctx.removeCookie(Config.SESSION_COOKIE_NAME);
        }
        if (userId != null) {
            AuditService.log(userId, "logout", "auth", null, "{}", ctx.ip(), ctx.userAgent());
        }
        ctx.status(204);
    }

    public static void me(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("userId", userId.toString());
        response.put("isPlatformAdmin", SuperAdminService.isPlatformAdmin(userId));
        ctx.json(response);
    }

    private static String parseEmailFromBody(String body) {
        try {
            if (body.startsWith("{")) {
                int start = body.indexOf("\"email\"");
                if (start < 0) return null;
                start = body.indexOf("\"", start + 7) + 1;
                int end = body.indexOf("\"", start);
                return end > start ? body.substring(start, end) : null;
            }
        } catch (Exception ignored) {}
        return null;
    }

    public static class VerifyRequest {
        public String email;
        public String code;
    }
}
