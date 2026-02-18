package com.bettercases.ai;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.logging.FileHandler;
import java.util.logging.Formatter;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;

public final class AiLoggers {
    private static final Logger GENERATION_LOGGER = Logger.getLogger("com.bettercases.ai.generation");
    private static final Logger PROVIDER_LOGGER = Logger.getLogger("com.bettercases.ai.provider");

    static {
        try {
            Path logsDir = resolveLogsDir();
            Files.createDirectories(logsDir);
            configureLogger(
                    GENERATION_LOGGER,
                    logsDir.resolve("ai-generation-requests.log").toString(),
                    true
            );
            configureLogger(
                    PROVIDER_LOGGER,
                    logsDir.resolve("ai-provider-interactions.log").toString(),
                    false
            );
        } catch (Exception e) {
            System.err.println("Failed to initialize AI file loggers: " + e.getMessage());
        }
    }

    private AiLoggers() {}

    public static void generationInfo(String message) {
        GENERATION_LOGGER.info(message);
    }

    public static void generationWarn(String message) {
        GENERATION_LOGGER.warning(message);
    }

    public static void generationError(String message, Throwable t) {
        GENERATION_LOGGER.log(Level.SEVERE, message, t);
    }

    public static void providerInfo(String message) {
        PROVIDER_LOGGER.info(message);
    }

    public static void providerWarn(String message) {
        PROVIDER_LOGGER.warning(message);
    }

    public static void providerError(String message, Throwable t) {
        PROVIDER_LOGGER.log(Level.SEVERE, message, t);
    }

    public static String truncate(String value, int maxLen) {
        if (value == null) return "";
        String normalized = value.replace('\n', ' ').replace('\r', ' ');
        if (normalized.length() <= maxLen) return normalized;
        return normalized.substring(0, maxLen) + "...(truncated)";
    }

    private static void configureLogger(Logger logger, String filePath, boolean mirrorToConsole) throws IOException {
        logger.setUseParentHandlers(mirrorToConsole);
        for (var h : logger.getHandlers()) {
            logger.removeHandler(h);
        }
        FileHandler fileHandler = new FileHandler(filePath, true);
        fileHandler.setFormatter(new SingleLineFormatter());
        logger.addHandler(fileHandler);
        logger.setLevel(Level.INFO);
    }

    private static Path resolveLogsDir() {
        Path cwd = Path.of(System.getProperty("user.dir", ""));
        if (Files.isDirectory(cwd.resolve("src"))) {
            return cwd.resolve("logs");
        }
        return cwd.resolve("backend").resolve("logs");
    }

    private static final class SingleLineFormatter extends Formatter {
        @Override
        public String format(LogRecord record) {
            String throwable = "";
            if (record.getThrown() != null) {
                throwable = " | error=" + record.getThrown().getClass().getSimpleName() + ":" + record.getThrown().getMessage();
            }
            return Instant.ofEpochMilli(record.getMillis()) + " | " +
                    record.getLevel().getName() + " | " +
                    formatMessage(record) +
                    throwable +
                    System.lineSeparator();
        }
    }
}
