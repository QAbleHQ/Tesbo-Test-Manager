package com.bettercases.export;

import com.bettercases.auth.SessionFilter;
import com.bettercases.Database;
import com.bettercases.rbac.RbacService;
import com.bettercases.testcase.TestCaseService;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.javalin.http.Context;
import io.javalin.http.UploadedFile;
import org.apache.poi.ss.usermodel.*;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

public final class ImportHandler {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final String[] TEMPLATE_HEADERS = {
        "Title", "Description", "Preconditions", "Postconditions",
        "Steps", "Test Data", "Priority", "Severity", "Type",
        "Automation Status", "Status", "Suite", "Component", "Estimated Duration"
    };

    private static final String[][] TEMPLATE_ROWS = {
        {"Login with valid credentials", "Verify user can log in with correct email and password", "User has a registered account", "User is on the dashboard",
         "1. Navigate to login page | Expected: Login form is displayed\n2. Enter email and password | Expected: Fields are populated\n3. Click Login | Expected: Redirected to dashboard",
         "email: user@test.com, password: Test123!", "P1", "Major", "Functional", "Not Automated", "Draft", "Default Suite", "Authentication", "5m"},
        {"Search returns relevant results", "Verify the search feature returns matching results", "User is logged in; test data exists", "",
         "1. Click search bar | Expected: Search input is focused\n2. Type search query | Expected: Results appear in dropdown",
         "query: \"test case\"", "P2", "", "Functional", "Not Automated", "Draft", "Default Suite", "Search", "3m"},
    };

    // Temporary storage for uploaded files between preview and execute calls
    private static final ConcurrentHashMap<String, UploadData> UPLOAD_CACHE = new ConcurrentHashMap<>();

    private static class UploadData {
        final List<String> headers;
        final List<String[]> rows;
        final long createdAt;
        UploadData(List<String> headers, List<String[]> rows) {
            this.headers = headers;
            this.rows = rows;
            this.createdAt = System.currentTimeMillis();
        }
    }

    static {
        // Cleanup thread: remove uploads older than 30 minutes
        Thread cleanup = new Thread(() -> {
            while (true) {
                try { Thread.sleep(300_000); } catch (InterruptedException e) { break; }
                long now = System.currentTimeMillis();
                UPLOAD_CACHE.entrySet().removeIf(e -> now - e.getValue().createdAt > 1_800_000);
            }
        });
        cleanup.setDaemon(true);
        cleanup.start();
    }

    // ---- Template download ----

    public static void downloadTemplate(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        RbacService.requireProjectRole(userId, projectId);

        String format = ctx.queryParam("format");
        if ("xlsx".equalsIgnoreCase(format)) {
            downloadTemplateXlsx(ctx);
        } else {
            downloadTemplateCsv(ctx);
        }
    }

    private static void downloadTemplateCsv(Context ctx) {
        StringBuilder csv = new StringBuilder();
        csv.append(String.join(",", TEMPLATE_HEADERS)).append("\n");
        for (String[] row : TEMPLATE_ROWS) {
            for (int i = 0; i < row.length; i++) {
                if (i > 0) csv.append(",");
                csv.append(ExportHandler.escapeCsv(row[i]));
            }
            csv.append("\n");
        }
        ctx.contentType("text/csv")
           .header("Content-Disposition", "attachment; filename=testcases-template.csv")
           .result(csv.toString());
    }

    private static void downloadTemplateXlsx(Context ctx) {
        try (XSSFWorkbook wb = new XSSFWorkbook()) {
            Sheet sheet = wb.createSheet("Template");
            CellStyle headerStyle = wb.createCellStyle();
            Font headerFont = wb.createFont();
            headerFont.setBold(true);
            headerStyle.setFont(headerFont);

            Row headerRow = sheet.createRow(0);
            for (int i = 0; i < TEMPLATE_HEADERS.length; i++) {
                Cell cell = headerRow.createCell(i);
                cell.setCellValue(TEMPLATE_HEADERS[i]);
                cell.setCellStyle(headerStyle);
            }
            for (int r = 0; r < TEMPLATE_ROWS.length; r++) {
                Row row = sheet.createRow(r + 1);
                for (int c = 0; c < TEMPLATE_ROWS[r].length; c++) {
                    row.createCell(c).setCellValue(TEMPLATE_ROWS[r][c]);
                }
            }
            for (int i = 0; i < TEMPLATE_HEADERS.length; i++) {
                sheet.autoSizeColumn(i);
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            wb.write(out);
            ctx.contentType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
               .header("Content-Disposition", "attachment; filename=testcases-template.xlsx")
               .result(out.toByteArray());
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    // ---- Preview (parse uploaded file) ----

    public static void preview(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canExportImport())
            throw new io.javalin.http.ForbiddenResponse("Cannot import");

        UploadedFile file = ctx.uploadedFile("file");
        if (file == null) throw new io.javalin.http.BadRequestResponse("No file uploaded");

        String filename = file.filename().toLowerCase();
        List<String> headers;
        List<String[]> allRows;
        try {
            if (filename.endsWith(".xlsx") || filename.endsWith(".xls")) {
                var parsed = parseExcel(file.content());
                headers = parsed.get(0) != null ? Arrays.asList(parsed.get(0)) : List.of();
                allRows = parsed.subList(1, parsed.size());
            } else {
                var parsed = parseCsv(file.content());
                headers = parsed.get(0) != null ? Arrays.asList(parsed.get(0)) : List.of();
                allRows = parsed.subList(1, parsed.size());
            }
        } catch (Exception e) {
            throw new io.javalin.http.BadRequestResponse("Failed to parse file: " + e.getMessage());
        }

        String uploadId = UUID.randomUUID().toString();
        UPLOAD_CACHE.put(uploadId, new UploadData(headers, allRows));

        List<String[]> previewRows = allRows.subList(0, Math.min(5, allRows.size()));

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("uploadId", uploadId);
        result.put("headers", headers);
        result.put("previewRows", previewRows);
        result.put("totalRows", allRows.size());
        ctx.json(result);
    }

    // ---- Execute import ----

    @SuppressWarnings("unchecked")
    public static void execute(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canExportImport())
            throw new io.javalin.http.ForbiddenResponse("Cannot import");

        Map<String, Object> body;
        try {
            body = MAPPER.readValue(ctx.body(), Map.class);
        } catch (Exception e) {
            throw new io.javalin.http.BadRequestResponse("Invalid request body");
        }

        String uploadId = (String) body.get("uploadId");
        Map<String, Object> columnMapping = (Map<String, Object>) body.get("columnMapping");
        if (uploadId == null || columnMapping == null) {
            throw new io.javalin.http.BadRequestResponse("uploadId and columnMapping are required");
        }

        UploadData data = UPLOAD_CACHE.remove(uploadId);
        if (data == null) {
            throw new io.javalin.http.BadRequestResponse("Upload expired or not found. Please re-upload the file.");
        }

        // columnMapping: { "title": 0, "description": 1, ... } (field name -> column index)
        Map<String, Integer> mapping = new HashMap<>();
        for (var entry : columnMapping.entrySet()) {
            mapping.put(entry.getKey(), ((Number) entry.getValue()).intValue());
        }

        if (!mapping.containsKey("title")) {
            throw new io.javalin.http.BadRequestResponse("Title column mapping is required");
        }

        // Resolve suite names to IDs, creating new suites as needed
        int suiteColIdx = mapping.getOrDefault("suite", -1);
        Map<String, String> suiteNameToId = new HashMap<>();
        if (suiteColIdx >= 0) {
            loadExistingSuites(projectId, suiteNameToId);
        }

        int imported = 0;
        List<Map<String, Object>> errors = new ArrayList<>();

        for (int i = 0; i < data.rows.size(); i++) {
            String[] row = data.rows.get(i);
            try {
                String title = getVal(row, mapping, "title");
                if (title == null || title.isBlank()) {
                    errors.add(Map.of("row", i + 2, "message", "Title is empty, skipped"));
                    continue;
                }

                TestCaseService.CreateDto dto = new TestCaseService.CreateDto();
                dto.title = title;
                dto.description = getVal(row, mapping, "description");
                dto.preconditions = getVal(row, mapping, "preconditions");
                dto.postconditions = getVal(row, mapping, "postconditions");
                dto.testData = getVal(row, mapping, "testData");
                dto.priority = getVal(row, mapping, "priority");
                dto.severity = getVal(row, mapping, "severity");
                dto.type = getVal(row, mapping, "type");
                dto.automationStatus = getVal(row, mapping, "automationStatus");
                dto.status = getVal(row, mapping, "status");
                dto.component = getVal(row, mapping, "component");
                dto.estimatedDuration = getVal(row, mapping, "estimatedDuration");

                String stepsRaw = getVal(row, mapping, "steps");
                if (stepsRaw != null && !stepsRaw.isBlank()) {
                    dto.steps = parseStepsToJson(stepsRaw);
                }

                String suiteName = suiteColIdx >= 0 ? getVal(row, mapping, "suite") : null;
                if (suiteName != null && !suiteName.isBlank()) {
                    dto.suiteId = resolveOrCreateSuite(projectId, suiteName, suiteNameToId);
                }

                TestCaseService.create(projectId, userId, dto);
                imported++;
            } catch (Exception e) {
                errors.add(Map.of("row", i + 2, "message", e.getMessage() != null ? e.getMessage() : "Unknown error"));
            }
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("imported", imported);
        result.put("errors", errors);
        result.put("total", data.rows.size());
        ctx.json(result);
    }

    // ---- Parsing helpers ----

    private static List<String[]> parseCsv(InputStream in) throws IOException {
        String content = new String(in.readAllBytes(), StandardCharsets.UTF_8);
        List<String[]> rows = new ArrayList<>();
        List<String> currentRow = new ArrayList<>();
        StringBuilder field = new StringBuilder();
        boolean inQuotes = false;

        for (int i = 0; i < content.length(); i++) {
            char ch = content.charAt(i);
            if (inQuotes) {
                if (ch == '"') {
                    if (i + 1 < content.length() && content.charAt(i + 1) == '"') {
                        field.append('"');
                        i++;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    field.append(ch);
                }
            } else {
                if (ch == '"') {
                    inQuotes = true;
                } else if (ch == ',') {
                    currentRow.add(field.toString());
                    field.setLength(0);
                } else if (ch == '\n') {
                    currentRow.add(field.toString());
                    field.setLength(0);
                    rows.add(currentRow.toArray(new String[0]));
                    currentRow = new ArrayList<>();
                } else if (ch == '\r') {
                    // skip, handle \r\n
                } else {
                    field.append(ch);
                }
            }
        }
        if (!currentRow.isEmpty() || field.length() > 0) {
            currentRow.add(field.toString());
            rows.add(currentRow.toArray(new String[0]));
        }
        // Remove trailing empty rows
        while (!rows.isEmpty()) {
            String[] last = rows.get(rows.size() - 1);
            if (last.length == 0 || (last.length == 1 && last[0].isBlank())) {
                rows.remove(rows.size() - 1);
            } else {
                break;
            }
        }
        return rows;
    }

    private static List<String[]> parseExcel(InputStream in) throws IOException {
        List<String[]> rows = new ArrayList<>();
        try (Workbook wb = WorkbookFactory.create(in)) {
            Sheet sheet = wb.getSheetAt(0);
            DataFormatter fmt = new DataFormatter();
            for (int r = 0; r <= sheet.getLastRowNum(); r++) {
                Row row = sheet.getRow(r);
                if (row == null) continue;
                String[] cells = new String[row.getLastCellNum()];
                for (int c = 0; c < row.getLastCellNum(); c++) {
                    Cell cell = row.getCell(c, Row.MissingCellPolicy.CREATE_NULL_AS_BLANK);
                    cells[c] = fmt.formatCellValue(cell);
                }
                boolean allBlank = true;
                for (String s : cells) if (s != null && !s.isBlank()) { allBlank = false; break; }
                if (!allBlank) rows.add(cells);
            }
        }
        return rows;
    }

    private static String getVal(String[] row, Map<String, Integer> mapping, String field) {
        Integer idx = mapping.get(field);
        if (idx == null || idx < 0 || idx >= row.length) return null;
        String v = row[idx];
        return (v != null && !v.isBlank()) ? v.trim() : null;
    }

    /**
     * Parses human-readable steps format into JSON array.
     * Supports: "1. action | Expected: result" per line
     * Falls back to treating each line as a step action.
     */
    private static String parseStepsToJson(String raw) {
        try {
            // If it already looks like JSON, pass through
            if (raw.trim().startsWith("[")) return raw;

            String[] lines = raw.split("\\n");
            List<Map<String, String>> steps = new ArrayList<>();
            for (int i = 0; i < lines.length; i++) {
                String line = lines[i].trim();
                if (line.isEmpty()) continue;
                // Remove leading number/dot prefix
                line = line.replaceFirst("^\\d+\\.\\s*", "");
                String action, expected = "";
                int pipeIdx = line.indexOf("| Expected:");
                if (pipeIdx >= 0) {
                    action = line.substring(0, pipeIdx).trim();
                    expected = line.substring(pipeIdx + "| Expected:".length()).trim();
                } else if (line.contains("|")) {
                    int idx = line.indexOf("|");
                    action = line.substring(0, idx).trim();
                    expected = line.substring(idx + 1).trim();
                } else {
                    action = line;
                }
                Map<String, String> step = new LinkedHashMap<>();
                step.put("stepNumber", String.valueOf(steps.size() + 1));
                step.put("action", action);
                step.put("expectedResult", expected);
                steps.add(step);
            }
            return MAPPER.writeValueAsString(steps);
        } catch (Exception e) {
            return "[]";
        }
    }

    private static void loadExistingSuites(UUID projectId, Map<String, String> suiteNameToId) {
        String sql = "SELECT id, name FROM suites WHERE project_id = ?";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                suiteNameToId.put(rs.getString("name").toLowerCase(), rs.getObject("id").toString());
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }

    private static String resolveOrCreateSuite(UUID projectId, String suiteName, Map<String, String> cache) {
        String key = suiteName.toLowerCase().trim();
        if (cache.containsKey(key)) return cache.get(key);
        // Create new suite
        String sql = "INSERT INTO suites (project_id, parent_id, name, position) VALUES (?, NULL, ?, 0) RETURNING id";
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ps.setString(2, suiteName.trim());
            ResultSet rs = ps.executeQuery();
            rs.next();
            String id = rs.getObject("id").toString();
            cache.put(key, id);
            return id;
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
    }
}
