package com.bettercases.auth;

import com.bettercases.Config;
import io.javalin.http.Context;
import io.javalin.http.Handler;

import java.util.Optional;
import java.util.UUID;

public final class SessionFilter implements Handler {
    public static final String CTX_USER_ID = "userId";
    private final OtpService otpService = new OtpService();

    @Override
    public void handle(Context ctx) throws Exception {
        String token = ctx.cookie(Config.SESSION_COOKIE_NAME);
        Optional<UUID> userId = otpService.resolveSession(token);
        ctx.attribute(CTX_USER_ID, userId.orElse(null));
    }

    public static Optional<UUID> getUserId(Context ctx) {
        return Optional.ofNullable((UUID) ctx.attribute(CTX_USER_ID));
    }

    public static UUID requireUserId(Context ctx) {
        return getUserId(ctx).orElseThrow(() -> new io.javalin.http.UnauthorizedResponse("Not authenticated"));
    }
}
