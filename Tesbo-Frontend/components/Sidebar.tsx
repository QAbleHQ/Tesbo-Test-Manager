"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import {
  IconHome,
  IconLayoutDashboard,
  IconStack2,
  IconSparkles,
  IconBook,
  IconFolders,
  IconClipboardList,
  IconFileText,
  IconPlayerPlay,
  IconBug,
  IconChartBar,
  IconActivity,
  IconSettings,
  IconUsers,
  IconPlug,
  IconLogout,
  IconChevronLeft,
  IconChevronRight,
  IconShield,
  IconKey,
  IconList,
} from "@tabler/icons-react";
import { authMe, listProjects, logout, type ProjectSummary } from "@/lib/api";
import { BrandLogo } from "@/components/BrandLogo";
import ThemeToggle from "@/components/ThemeToggle";

type NavItemConfig = {
  href: string;
  label: string;
  icon: MenuIconName;
  children?: Array<{
    href: string;
    label: string;
    icon: MenuIconName;
  }>;
};

const globalNavItems: NavItemConfig[] = [
  { href: "/projects", label: "Projects", icon: "project" },
  { href: "/dashboard", label: "Workspace Insights", icon: "dashboard" },
];

const projectNavSections: Array<{ section: string; items: NavItemConfig[] }> = [
  {
    section: "Overview",
    items: [
      { href: "", label: "Project home", icon: "home" },
      { href: "activity", label: "Activity stream", icon: "activity" },
    ],
  },
  {
    section: "Test management",
    items: [
      { href: "testcases", label: "Test cases", icon: "fileText" },
      { href: "suites", label: "Suites", icon: "folders" },
      { href: "plans", label: "Test plans", icon: "clipboard" },
    ],
  },
  {
    section: "Execution",
    items: [
      { href: "cycles", label: "Runs", icon: "play" },
      { href: "bugs", label: "Bugs", icon: "bug" },
      { href: "reports", label: "Insights", icon: "chart" },
    ],
  },
  {
    section: "Assets",
    items: [
      {
        href: "agents",
        label: "Agents",
        icon: "sparkles",
        children: [
          { href: "agents/tasks", label: "Tasks", icon: "clipboard" },
          { href: "agents", label: "Agent list", icon: "settings" },
        ],
      },
      { href: "knowledge-base", label: "Knowledge base", icon: "book" },
    ],
  },
];


const workspaceSettingsNavItems = [
  { href: "/settings/members", label: "Members", icon: "users" },
  { href: "/settings/integrations", label: "Integrations", icon: "plug" },
] as const;

const workspaceModeNavItems: NavItemConfig[] = [
  ...globalNavItems,
  ...workspaceSettingsNavItems,
];

// Easy rollback switch: set to false to disable
const ENABLE_SCOPE_SWITCHER = true;
type NavScope = "workspace" | "project";

type MenuIconName =
  | "home" | "dashboard" | "project" | "sparkles" | "history"
  | "book" | "list" | "folders" | "fileText" | "clipboard" | "play" | "bug" | "chart"
  | "activity" | "runs" | "specs" | "tests" | "analytics"
  | "settings" | "users" | "plug" | "logout"
  | "chevronLeft" | "chevronRight" | "adminPanel" | "key";

function MenuIcon({ name, className = "h-[20px] w-[20px]" }: { name: MenuIconName; className?: string }) {
  const props = { className, size: 20, stroke: 1.75 } as const;
  switch (name) {
    case "home":        return <IconHome {...props} />;
    case "dashboard":   return <IconLayoutDashboard {...props} />;
    case "project":     return <IconStack2 {...props} />;
    case "sparkles":    return <IconSparkles {...props} />;
    case "book":        return <IconBook {...props} />;
    case "list":        return <IconList {...props} />;
    case "folders":     return <IconFolders {...props} />;
    case "fileText":    return <IconFileText {...props} />;
    case "clipboard":   return <IconClipboardList {...props} />;
    case "play":        return <IconPlayerPlay {...props} />;
    case "bug":         return <IconBug {...props} />;
    case "chart":       return <IconChartBar {...props} />;
    case "activity":    return <IconActivity {...props} />;
    case "settings":    return <IconSettings {...props} />;
    case "users":       return <IconUsers {...props} />;
    case "plug":        return <IconPlug {...props} />;
    case "logout":      return <IconLogout {...props} />;
    case "chevronLeft": return <IconChevronLeft {...props} />;
    case "chevronRight":return <IconChevronRight {...props} />;
    case "adminPanel":  return <IconShield {...props} />;
    case "key":         return <IconKey {...props} />;
    default:            return null;
  }
}

function NavLink({
  href,
  label,
  icon,
  collapsed = false,
  active = false,
  nested = false,
}: {
  href: string;
  label: string;
  icon: MenuIconName;
  collapsed?: boolean;
  active?: boolean;
  nested?: boolean;
}) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      aria-label={label}
      className={`group relative flex items-center overflow-hidden rounded-[6px] py-2 text-[13px] transition-colors duration-150 ${
        collapsed
          ? "justify-center px-2"
          : nested
            ? "gap-2 pl-10 pr-3"
            : "gap-2 pl-3 pr-3"
      } ${
        active
          ? "tesbo-nav-item tesbo-nav-item-active"
          : "tesbo-nav-item tesbo-nav-item-idle text-[var(--ink-400)] hover:text-[var(--ink-800)]"
      }`}
    >
      <MenuIcon
        name={icon}
        className={`h-[18px] w-[18px] shrink-0 ${
          active ? "text-[var(--denim)]" : "text-[var(--ink-300)]"
        }`}
      />
      {collapsed ? <span className="sr-only">{label}</span> : <span className="truncate">{label}</span>}
    </Link>
  );
}

function SidebarContent() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectMatch = pathname?.match(/^\/projects\/([^/]+)/);
  const projectId = projectMatch?.[1] ?? null;
  const isInProject = Boolean(projectId);
  const projectPathPrefix = projectId ? `/projects/${projectId}` : "/projects";

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);

  useEffect(() => {
    let active = true;
    authMe().then((data) => {
      if (active && data?.isPlatformAdmin) setIsPlatformAdmin(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!ENABLE_SCOPE_SWITCHER) return;
    let active = true;
    listProjects()
      .then((items) => {
        if (active) setProjects(Array.isArray(items) ? items : []);
      })
      .catch(() => {
        if (active) setProjects([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const isOnProjectRoot = projectId != null && pathname === `/projects/${projectId}`;
  const isPathActive = (href: string) => {
    if (!pathname) return false;
    const [cleanHref, queryStr] = href.split("?");
    const pathMatch = pathname === cleanHref || pathname.startsWith(`${cleanHref}/`);
    if (!pathMatch) return false;
    if (queryStr) {
      const hrefParams = new URLSearchParams(queryStr);
      for (const [k, v] of hrefParams.entries()) {
        if (searchParams.get(k) !== v) return false;
      }
    }
    return true;
  };

  const onLogout = async () => {
    if (isLoggingOut) return;
    setLogoutError(null);
    setIsLoggingOut(true);
    try {
      await logout();
      if (typeof window !== "undefined") localStorage.removeItem("token");
      router.replace("/login");
      router.refresh();
    } catch {
      setLogoutError("Could not log out. Please try again.");
      setIsLoggingOut(false);
    }
  };

  const onScopeChange = (scope: NavScope) => {
    if (scope === "workspace" && isInProject) {
      router.push("/projects");
      return;
    }
    if (scope === "project" && !isInProject) {
      const fallbackProjectId = projects[0]?.id;
      if (fallbackProjectId) router.push(`/projects/${fallbackProjectId}`);
    }
  };

  const onProjectSelect = (nextProjectId: string) => {
    if (!nextProjectId) return;
    router.push(`/projects/${nextProjectId}`);
  };

  const navScope: NavScope = isInProject ? "project" : "workspace";
  const showGlobalNavigation = !ENABLE_SCOPE_SWITCHER || !isInProject;
  const showProjectNavigation = isInProject && Boolean(projectId);

  return (
    <aside
      className={`tesbo-sidebar sticky top-0 shrink-0 flex h-screen flex-col border-r transition-[width] duration-200 ${
        isCollapsed ? "w-[52px]" : "w-[260px]"
      }`}
    >
      <div className="flex h-16 items-center justify-between gap-2 border-b border-[var(--glass-border)] px-3">
        <Link href="/projects" className={`flex items-center ${isCollapsed ? "justify-center" : ""}`} aria-label="Tesbo Test Manager">
          {isCollapsed ? (
            <span className="grid h-9 w-9 place-items-center rounded-xl border border-[var(--glass-border)] bg-[var(--glass-surface-strong)] shadow-sm">
              <BrandLogo decorative className="h-7 w-auto object-contain" />
            </span>
          ) : (
            <BrandLogo className="h-10 max-w-[150px] object-contain" />
          )}
        </Link>
        <button
          type="button"
          onClick={() => setIsCollapsed((prev) => !prev)}
          className="rounded-xl border border-transparent p-1.5 text-[var(--muted-soft)] transition-colors hover:border-[var(--glass-border)] hover:bg-[var(--glass-surface-muted)] hover:text-[var(--foreground)]"
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <MenuIcon name={isCollapsed ? "chevronRight" : "chevronLeft"} className="h-[16px] w-[16px]" />
        </button>
      </div>

      {ENABLE_SCOPE_SWITCHER && !isCollapsed && (
        <div className="border-b border-[var(--glass-border)] px-3 py-3">
          <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">Scope Lock</p>
          <div className="tesbo-glass-strong mt-2 grid grid-cols-2 rounded-xl p-1">
            <button
              type="button"
              onClick={() => onScopeChange("workspace")}
              className={`rounded-lg px-2 py-1.5 text-[12px] font-semibold transition-colors ${
                navScope === "workspace"
                  ? "bg-[var(--denim)] text-white shadow-sm"
                  : "text-[var(--muted)] hover:bg-[var(--glass-surface-muted)] hover:text-[var(--foreground)]"
              }`}
            >
              Workspace
            </button>
            <button
              type="button"
              onClick={() => onScopeChange("project")}
              className={`rounded-lg px-2 py-1.5 text-[12px] font-semibold transition-colors ${
                navScope === "project"
                  ? "bg-[var(--denim)] text-white shadow-sm"
                  : "text-[var(--muted)] hover:bg-[var(--glass-surface-muted)] hover:text-[var(--foreground)]"
              }`}
            >
              Project
            </button>
          </div>
          {navScope === "project" && (
            <div className="mt-2">
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">
                Project Switcher
              </label>
              <select
                value={projectId ?? ""}
                onChange={(e) => onProjectSelect(e.target.value)}
                className="w-full rounded-xl border border-[var(--glass-border)] bg-[var(--glass-surface-strong)] px-3 py-2 text-[13px] text-[var(--foreground)] shadow-[var(--shadow-card)] backdrop-blur"
              >
                <option value="" disabled>
                  Select project
                </option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      <nav className="flex-1 space-y-3 overflow-y-auto px-2.5 pb-3 pt-3">
        {showGlobalNavigation && (
          <div className="space-y-0.5">
            {(ENABLE_SCOPE_SWITCHER ? workspaceModeNavItems : globalNavItems).map(({ href, label, icon }) => (
              <NavLink key={href} href={href} label={label} icon={icon} active={isPathActive(href)} collapsed={isCollapsed} />
            ))}
          </div>
        )}

        {showProjectNavigation ? (
          <>
            <div className="space-y-3">
              {projectNavSections.map(({ section, items }) => (
                <div key={section}>
                  {!isCollapsed && (
                    <p className="mb-1 px-3 text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--ink-300)]">
                      {section}
                    </p>
                  )}
                  <div className="space-y-0.5">
                    {items.map(({ href, label, icon, children }) => {
                      const fullHref = href ? `${projectPathPrefix}/${href}` : projectPathPrefix;
                      const active = isPathActive(fullHref) || (href === "" && isOnProjectRoot);
                      const isParentOpen = Boolean(children && active);

                      return (
                        <div key={href || label}>
                          <NavLink href={fullHref} label={label} icon={icon} active={active} collapsed={isCollapsed} />
                          {!isCollapsed && isParentOpen && children ? (
                            <div className="mt-0.5 space-y-0.5">
                              {children.map((child) => {
                                const childHref = `${projectPathPrefix}/${child.href}`;
                                const childActive =
                                  child.href === "agents"
                                    ? pathname === childHref
                                    : isPathActive(childHref);
                                return (
                                  <NavLink
                                    key={child.href}
                                    href={childHref}
                                    label={child.label}
                                    icon={child.icon}
                                    active={childActive}
                                    collapsed={isCollapsed}
                                    nested
                                  />
                                );
                              })}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              <NavLink
                href={`${projectPathPrefix}/settings`}
                label="Settings"
                icon="settings"
                active={pathname === `${projectPathPrefix}/settings` || (pathname?.startsWith(`${projectPathPrefix}/settings/`) ?? false)}
                collapsed={isCollapsed}
              />
            </div>
          </>
        ) : null}

        {/* Workspace settings */}
        {showGlobalNavigation && !ENABLE_SCOPE_SWITCHER && (
          <div>
            {!isCollapsed && (
              <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">
                Workspace
              </p>
            )}
            {workspaceSettingsNavItems.map(({ href, label, icon }) => {
              const active = pathname === href || pathname?.startsWith(`${href}/`);
              return <NavLink key={href} href={href} label={label} icon={icon} active={active} collapsed={isCollapsed} />;
            })}
          </div>
        )}
      </nav>

      <div className="space-y-2 border-t border-[var(--glass-border)] p-2.5">
        {!isCollapsed && (
          <div className="tesbo-glass-strong rounded-xl p-2">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">
              Theme
            </p>
            <ThemeToggle />
          </div>
        )}
        {isPlatformAdmin && (
          <NavLink
            href="/admin"
            label="Admin Panel"
            icon="adminPanel"
            active={pathname?.startsWith("/admin") ?? false}
            collapsed={isCollapsed}
          />
        )}
        <button
          type="button"
          onClick={onLogout}
          disabled={isLoggingOut}
          className={`w-full rounded-xl border border-transparent py-2 text-[14px] text-[var(--muted)] transition-colors hover:border-[var(--glass-border)] hover:bg-[var(--glass-surface-muted)] hover:text-[var(--foreground)] disabled:opacity-60 ${
            isCollapsed ? "flex justify-center px-2" : "flex items-center gap-2.5 px-2.5 text-left"
          }`}
          aria-label={isLoggingOut ? "Logging out" : "Log out"}
        >
          <MenuIcon name="logout" className="h-[20px] w-[20px] shrink-0 text-[var(--ink-300)]" />
          {isCollapsed ? (
            <span className="sr-only">{isLoggingOut ? "Logging out..." : "Log out"}</span>
          ) : (
            <span>{isLoggingOut ? "Logging out..." : "Log out"}</span>
          )}
        </button>
        {logoutError && !isCollapsed && (
          <p className="mt-1.5 px-2.5 text-xs text-[var(--error)]">{logoutError}</p>
        )}
      </div>
    </aside>
  );
}

export default function Sidebar() {
  return (
    <Suspense>
      <SidebarContent />
    </Suspense>
  );
}
