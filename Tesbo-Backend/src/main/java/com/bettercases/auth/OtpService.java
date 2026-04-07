package com.bettercases.auth;

import com.bettercases.Config;
import com.bettercases.Database;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.sql.*;
import java.time.Instant;
import java.util.Base64;
import java.util.Optional;
import java.util.UUID;

public final class OtpService {
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final int OTP_LENGTH = 6;
    private final EmailService emailService = new EmailService();

    /** Returns true if OTP was created and email delivery was attempted. */
    public boolean requestOtp(String email, String ipAddress, String userAgent) {
        if (email == null || (email = email.trim().toLowerCase()).isEmpty()) return false;
        String ipKey = rateLimitKeyForIp(ipAddress);
        if (isRateLimited(email) || isRateLimited(ipKey)) return false;

        String plainCode = generateOtp();
        String codeHash = hash(plainCode);
        Instant expiresAt = Instant.now().plusSeconds(Config.OTP_EXPIRY_MINUTES * 60L);

        String sql = "INSERT INTO otp_codes (email, code_hash, expires_at) VALUES (?, ?, ?)";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, email);
            ps.setString(2, codeHash);
            ps.setTimestamp(3, Timestamp.from(expiresAt));
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }

        recordOtpAttempt(email);
        recordOtpAttempt(ipKey);
        emailService.sendOtp(email, plainCode);
        return true;
    }

    /** Verifies OTP; returns session token if valid. OTP is single-use. */
    public Optional<String> verifyOtp(String email, String code, String ipAddress, String userAgent) {
        if (email == null || code == null) return Optional.empty();
        email = email.trim().toLowerCase();
        String ipKey = rateLimitKeyForIp(ipAddress);
        if (isRateLimited(email) || isRateLimited(ipKey)) return Optional.empty();

        String trimmedCode = code.trim();
        String codeHash = hash(trimmedCode);
        String selectSql = "SELECT id FROM otp_codes WHERE email = ? AND code_hash = ? AND expires_at > ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1";
        UUID otpId = null;
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(selectSql)) {
            ps.setString(1, email);
            ps.setString(2, codeHash);
            ps.setTimestamp(3, Timestamp.from(Instant.now()));
            ResultSet rs = ps.executeQuery();
            if (rs.next()) otpId = (UUID) rs.getObject("id");
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }

        if (otpId == null) {
            recordOtpAttempt(email);
            recordOtpAttempt(ipKey);
            return Optional.empty();
        }

        markOtpUsed(otpId);
        Optional<UUID> userId = findOrCreateUser(email);
        if (userId.isEmpty()) return Optional.empty();
        String sessionToken = createSession(userId.get(), ipAddress, userAgent);
        clearRateLimit(email);
        clearRateLimit(ipKey);
        return Optional.of(sessionToken);
    }

    private boolean isRateLimited(String email) {
        String sql = "SELECT locked_until FROM otp_rate_limit WHERE email = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, email);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) {
                Timestamp locked = rs.getTimestamp("locked_until");
                if (locked != null && locked.toInstant().isAfter(Instant.now()))
                    return true;
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return false;
    }

    private void recordOtpAttempt(String key) {
        String sql = "INSERT INTO otp_rate_limit (email, attempt_count, locked_until, updated_at) VALUES (?, 1, ?, now()) " +
                "ON CONFLICT (email) DO UPDATE SET attempt_count = otp_rate_limit.attempt_count + 1, " +
                "locked_until = CASE WHEN otp_rate_limit.attempt_count + 1 >= ? THEN now() + (? || ' minutes')::interval ELSE otp_rate_limit.locked_until END, updated_at = now()";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, key);
            ps.setNull(2, Types.TIMESTAMP);
            ps.setInt(3, Config.OTP_MAX_ATTEMPTS);
            ps.setInt(4, Config.OTP_RATE_LIMIT_WINDOW_MINUTES);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private void clearRateLimit(String email) {
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("DELETE FROM otp_rate_limit WHERE email = ?")) {
            ps.setString(1, email);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private void markOtpUsed(UUID otpId) {
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("UPDATE otp_codes SET used_at = now() WHERE id = ?")) {
            ps.setObject(1, otpId);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private Optional<UUID> findOrCreateUser(String email) {
        String selectSql = "SELECT id FROM users WHERE email = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(selectSql)) {
            ps.setString(1, email);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) return Optional.of((UUID) rs.getObject("id"));
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        String insertSql = "INSERT INTO users (email, name) VALUES (?, ?) ON CONFLICT (email) DO NOTHING RETURNING id";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(insertSql)) {
            ps.setString(1, email);
            ps.setString(2, email.split("@")[0]);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) return Optional.of((UUID) rs.getObject("id"));
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return findOrCreateUser(email);
    }

    private String createSession(UUID userId, String ipAddress, String userAgent) {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        String tokenHash = hash(token);
        Instant expiresAt = Instant.now().plusSeconds(Config.SESSION_DAYS * 86400L);
        String sql = "INSERT INTO sessions (user_id, token_hash, user_agent, ip_address, expires_at) VALUES (?, ?, ?, ?, ?)";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, userId);
            ps.setString(2, tokenHash);
            ps.setString(3, userAgent);
            ps.setString(4, ipAddress);
            ps.setTimestamp(5, Timestamp.from(expiresAt));
            ps.executeUpdate();
            return token;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    public Optional<UUID> resolveSession(String sessionToken) {
        if (sessionToken == null || sessionToken.isBlank()) return Optional.empty();
        String tokenHash = hash(sessionToken);
        String sql = "SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, tokenHash);
            ps.setTimestamp(2, Timestamp.from(Instant.now()));
            ResultSet rs = ps.executeQuery();
            if (rs.next()) return Optional.of((UUID) rs.getObject("user_id"));
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return Optional.empty();
    }

    public void invalidateSession(String sessionToken) {
        if (sessionToken == null || sessionToken.isBlank()) return;
        String tokenHash = hash(sessionToken);
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("DELETE FROM sessions WHERE token_hash = ?")) {
            ps.setString(1, tokenHash);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static String rateLimitKeyForIp(String ipAddress) {
        String normalizedIp = ipAddress == null ? "" : ipAddress.trim();
        return "ip:" + normalizedIp;
    }

    private static String generateOtp() {
        StringBuilder sb = new StringBuilder(OTP_LENGTH);
        for (int i = 0; i < OTP_LENGTH; i++) sb.append(RANDOM.nextInt(10));
        return sb.toString();
    }

    private static String hash(String value) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(value.getBytes(StandardCharsets.UTF_8));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(digest);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
}
