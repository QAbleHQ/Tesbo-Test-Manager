package com.bettercases.rbac;

import java.util.Set;

public enum Role {
    OWNER,
    ADMIN,
    MANAGER,
    MEMBER,
    VIEWER;

    private static final Set<Role> CAN_MANAGE_PROJECT = Set.of(OWNER, ADMIN, MANAGER);
    private static final Set<Role> CAN_MANAGE_MEMBERS = Set.of(OWNER, ADMIN, MANAGER);
    private static final Set<Role> CAN_EDIT_CASES = Set.of(OWNER, ADMIN, MANAGER, MEMBER);
    private static final Set<Role> CAN_APPROVE_CASES = Set.of(OWNER, ADMIN, MANAGER);
    private static final Set<Role> CAN_MANAGE_PLANS_CYCLES = Set.of(OWNER, ADMIN, MANAGER);
    private static final Set<Role> CAN_EXECUTE = Set.of(OWNER, ADMIN, MANAGER, MEMBER);
    private static final Set<Role> CAN_EDIT_OTHERS_EXECUTIONS = Set.of(OWNER, ADMIN, MANAGER);
    private static final Set<Role> CAN_VIEW_REPORTS = Set.of(OWNER, ADMIN, MANAGER, MEMBER, VIEWER);
    private static final Set<Role> CAN_MANAGE_INTEGRATIONS = Set.of(OWNER, ADMIN, MANAGER);
    private static final Set<Role> CAN_EXPORT_IMPORT = Set.of(OWNER, ADMIN, MANAGER);

    public boolean canManageProject() { return CAN_MANAGE_PROJECT.contains(this); }
    public boolean canManageMembers() { return CAN_MANAGE_MEMBERS.contains(this); }
    public boolean canEditCases() { return CAN_EDIT_CASES.contains(this); }
    public boolean canApproveCases() { return CAN_APPROVE_CASES.contains(this); }
    public boolean canManagePlansCycles() { return CAN_MANAGE_PLANS_CYCLES.contains(this); }
    public boolean canExecute() { return CAN_EXECUTE.contains(this); }
    public boolean canEditOthersExecutions() { return CAN_EDIT_OTHERS_EXECUTIONS.contains(this); }
    public boolean canViewReports() { return CAN_VIEW_REPORTS.contains(this); }
    public boolean canManageIntegrations() { return CAN_MANAGE_INTEGRATIONS.contains(this); }
    public boolean canExportImport() { return CAN_EXPORT_IMPORT.contains(this); }
    public boolean canView() { return true; }

    public static Role fromString(String s) {
        if (s == null) return VIEWER;
        String normalized = s.trim().toLowerCase().replace("-", "_").replace(" ", "_");
        if (normalized.isEmpty()) return VIEWER;
        // Backward compatibility for legacy project role values stored in DB.
        switch (normalized) {
            case "project_admin":
                return ADMIN;
            case "test_manager":
                return MANAGER;
            case "qa_member":
                return MEMBER;
            case "viewer":
                return VIEWER;
            default:
                break;
        }
        try {
            return valueOf(normalized.toUpperCase());
        } catch (IllegalArgumentException e) {
            return VIEWER;
        }
    }
}
