package com.bettercases.export;

import com.bettercases.auth.SessionFilter;
import com.bettercases.Database;
import com.bettercases.rbac.RbacService;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.javalin.http.Context;
import org.apache.poi.ss.usermodel.*;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;

import java.io.ByteArrayOutputStream;
import java.sql.*;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class ExportHandler {

    private static final String[] EXPORT_HEADERS = {
        "External ID", "Title", "Description", "Preconditions", "Postconditions",
        "Steps", "Test Data", "Priority", "Severity", "Type",
        "Automation Status", "Status", "Suite", "Component", "Estimated Duration",
        "Jira Issue Key"
    };

    private static final String EXPORT_SQL =
        "SELECT t.external_id, t.title, t.description, t.preconditions, t.postconditions, " +
        "t.steps, t.test_data, t.priority, t.severity, t.type, " +
        "t.automation_status, t.status, s.name AS suite_name, t.component, t.estimated_duration, " +
        "t.jira_issue_key " +
        "FROM testcases t LEFT JOIN suites s ON s.id = t.suite_id " +
        "WHERE t.project_id = ? ORDER BY t.external_id";

    private static final ObjectMapper MAPPER = new ObjectMapper();

    public static void exportCasesCsv(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canExportImport())
            throw new io.javalin.http.ForbiddenResponse("Cannot export");

        StringBuilder csv = new StringBuilder();
        csv.append(String.join(",", EXPORT_HEADERS)).append("\n");
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(EXPORT_SQL)) {
            ps.setObject(1, projectId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                appendCsvRow(csv, rs);
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        ctx.contentType("text/csv")
           .header("Content-Disposition", "attachment; filename=testcases.csv")
           .result(csv.toString());
    }

    public static void exportCasesXlsx(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canExportImport())
            throw new io.javalin.http.ForbiddenResponse("Cannot export");

        try (XSSFWorkbook wb = new XSSFWorkbook()) {
            Sheet sheet = wb.createSheet("Test Cases");
            CellStyle headerStyle = wb.createCellStyle();
            Font headerFont = wb.createFont();
            headerFont.setBold(true);
            headerStyle.setFont(headerFont);

            Row headerRow = sheet.createRow(0);
            for (int i = 0; i < EXPORT_HEADERS.length; i++) {
                Cell cell = headerRow.createCell(i);
                cell.setCellValue(EXPORT_HEADERS[i]);
                cell.setCellStyle(headerStyle);
            }

            try (Connection c = Database.getDataSource().getConnection();
                 PreparedStatement ps = c.prepareStatement(EXPORT_SQL)) {
                ps.setObject(1, projectId);
                ResultSet rs = ps.executeQuery();
                int rowIdx = 1;
                while (rs.next()) {
                    Row row = sheet.createRow(rowIdx++);
                    row.createCell(0).setCellValue(str(rs, "external_id"));
                    row.createCell(1).setCellValue(str(rs, "title"));
                    row.createCell(2).setCellValue(str(rs, "description"));
                    row.createCell(3).setCellValue(str(rs, "preconditions"));
                    row.createCell(4).setCellValue(str(rs, "postconditions"));
                    row.createCell(5).setCellValue(formatSteps(rs.getString("steps")));
                    row.createCell(6).setCellValue(str(rs, "test_data"));
                    row.createCell(7).setCellValue(str(rs, "priority"));
                    row.createCell(8).setCellValue(str(rs, "severity"));
                    row.createCell(9).setCellValue(str(rs, "type"));
                    row.createCell(10).setCellValue(str(rs, "automation_status"));
                    row.createCell(11).setCellValue(str(rs, "status"));
                    row.createCell(12).setCellValue(str(rs, "suite_name"));
                    row.createCell(13).setCellValue(str(rs, "component"));
                    row.createCell(14).setCellValue(str(rs, "estimated_duration"));
                    row.createCell(15).setCellValue(str(rs, "jira_issue_key"));
                }
            }

            for (int i = 0; i < EXPORT_HEADERS.length; i++) {
                sheet.autoSizeColumn(i);
            }

            ByteArrayOutputStream out = new ByteArrayOutputStream();
            wb.write(out);
            ctx.contentType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
               .header("Content-Disposition", "attachment; filename=testcases.xlsx")
               .result(out.toByteArray());
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static void exportCycleCsv(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID cycleId = UUID.fromString(ctx.pathParam("cycleId"));
        UUID projectId = getProjectId(cycleId);
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canExportImport())
            throw new io.javalin.http.ForbiddenResponse("Cannot export");
        String sql = "SELECT ci.snapshot_title, e.status, e.actual_result, e.defect_key FROM cycle_items ci JOIN executions e ON e.cycle_item_id = ci.id WHERE ci.cycle_id = ? ORDER BY ci.position";
        StringBuilder csv = new StringBuilder();
        csv.append("title,status,actual_result,defect_key\n");
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, cycleId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                csv.append(escapeCsv(rs.getString("snapshot_title"))).append(",");
                csv.append(escapeCsv(rs.getString("status"))).append(",");
                csv.append(escapeCsv(rs.getString("actual_result"))).append(",");
                csv.append(escapeCsv(rs.getString("defect_key"))).append("\n");
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        ctx.contentType("text/csv").header("Content-Disposition", "attachment; filename=cycle-results.csv").result(csv.toString());
    }

    private static void appendCsvRow(StringBuilder csv, ResultSet rs) throws SQLException {
        csv.append(escapeCsv(str(rs, "external_id"))).append(",");
        csv.append(escapeCsv(str(rs, "title"))).append(",");
        csv.append(escapeCsv(str(rs, "description"))).append(",");
        csv.append(escapeCsv(str(rs, "preconditions"))).append(",");
        csv.append(escapeCsv(str(rs, "postconditions"))).append(",");
        csv.append(escapeCsv(formatSteps(rs.getString("steps")))).append(",");
        csv.append(escapeCsv(str(rs, "test_data"))).append(",");
        csv.append(escapeCsv(str(rs, "priority"))).append(",");
        csv.append(escapeCsv(str(rs, "severity"))).append(",");
        csv.append(escapeCsv(str(rs, "type"))).append(",");
        csv.append(escapeCsv(str(rs, "automation_status"))).append(",");
        csv.append(escapeCsv(str(rs, "status"))).append(",");
        csv.append(escapeCsv(str(rs, "suite_name"))).append(",");
        csv.append(escapeCsv(str(rs, "component"))).append(",");
        csv.append(escapeCsv(str(rs, "estimated_duration"))).append(",");
        csv.append(escapeCsv(str(rs, "jira_issue_key"))).append("\n");
    }

    static String formatSteps(String stepsJson) {
        if (stepsJson == null || stepsJson.isBlank() || "[]".equals(stepsJson.trim())) return "";
        try {
            List<Map<String, Object>> steps = MAPPER.readValue(stepsJson, new TypeReference<>() {});
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < steps.size(); i++) {
                Map<String, Object> step = steps.get(i);
                String action = step.getOrDefault("action", "").toString();
                String expected = step.getOrDefault("expectedResult", "").toString();
                if (i > 0) sb.append("\n");
                sb.append(i + 1).append(". ").append(action);
                if (!expected.isEmpty()) sb.append(" | Expected: ").append(expected);
            }
            return sb.toString();
        } catch (Exception e) {
            return stepsJson;
        }
    }

    static String escapeCsv(String s) {
        if (s == null) return "";
        if (s.contains(",") || s.contains("\"") || s.contains("\n")) return "\"" + s.replace("\"", "\"\"") + "\"";
        return s;
    }

    private static String str(ResultSet rs, String col) throws SQLException {
        String v = rs.getString(col);
        return v != null ? v : "";
    }

    private static UUID getProjectId(UUID cycleId) {
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement("SELECT project_id FROM cycles WHERE id = ?")) {
            ps.setObject(1, cycleId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) return (UUID) rs.getObject("project_id");
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        throw new io.javalin.http.NotFoundResponse();
    }
}
