package com.bettercases.export;

import com.bettercases.auth.SessionFilter;
import com.bettercases.Database;
import com.bettercases.rbac.RbacService;

import io.javalin.http.Context;

import java.sql.*;
import java.util.UUID;

public final class ExportHandler {
    public static void exportCasesCsv(Context ctx) {
        UUID userId = SessionFilter.requireUserId(ctx);
        UUID projectId = UUID.fromString(ctx.pathParam("projectId"));
        RbacService.requireProjectRole(userId, projectId);
        if (!RbacService.getProjectRole(userId, projectId).get().canExportImport())
            throw new io.javalin.http.ForbiddenResponse("Cannot export");
        String sql = "SELECT external_id, title, description, preconditions, priority, type, status FROM testcases WHERE project_id = ? ORDER BY external_id";
        StringBuilder csv = new StringBuilder();
        csv.append("external_id,title,description,preconditions,priority,type,status\n");
        try (Connection c = Database.getDataSource().getConnection();
             PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, projectId);
            ResultSet rs = ps.executeQuery();
            while (rs.next()) {
                csv.append(escapeCsv(rs.getString("external_id"))).append(",");
                csv.append(escapeCsv(rs.getString("title"))).append(",");
                csv.append(escapeCsv(rs.getString("description"))).append(",");
                csv.append(escapeCsv(rs.getString("preconditions"))).append(",");
                csv.append(escapeCsv(rs.getString("priority"))).append(",");
                csv.append(escapeCsv(rs.getString("type"))).append(",");
                csv.append(escapeCsv(rs.getString("status"))).append("\n");
            }
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        ctx.contentType("text/csv").header("Content-Disposition", "attachment; filename=testcases.csv").result(csv.toString());
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

    private static String escapeCsv(String s) {
        if (s == null) return "";
        if (s.contains(",") || s.contains("\"") || s.contains("\n")) return "\"" + s.replace("\"", "\"\"") + "\"";
        return s;
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
